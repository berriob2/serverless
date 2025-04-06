/**
 * Convert images to PDF function
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileTypeFromFile } from 'file-type';
import PDFDocument from 'pdfkit';
import { parse } from 'lambda-multipart-parser'; // Added for multipart parsing

import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { updateJob } from '../lib/dynamodb.js'; // Added for consistent job tracking

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Convert images to PDF
 * @param {object} event - API Gateway event
 * @param {object} context - Lambda context
 * @returns {Promise<object>} - Response
 */
export async function handler(event, context) {
  // Ensure tmp directory exists
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  try {
    // Parse multipart/form-data from API Gateway event
    const parsedEvent = await parse(event);
    const files = parsedEvent.files;

    if (!files || files.length === 0) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No images uploaded.' })
      };
    }

    // Validate file sizes (100 MB limit per file)
    for (const file of files) {
      if (file.size > 100 * 1024 * 1024) {
        await cleanupFiles(...files.map(f => f.path));
        return {
          statusCode: 413,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'One or more files exceed 100 MB limit.' })
        };
      }
    }

    // Validate file types
    const validImageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff'];
    const validImageMimeTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', 'image/tiff',
    ];

    for (const file of files) {
      const fileExtension = path.extname(file.filename).slice(1).toLowerCase();
      const detectedType = await fileTypeFromFile(file.path);
      if (!validImageExtensions.includes(fileExtension) || !detectedType || !validImageMimeTypes.includes(detectedType.mime)) {
        await cleanupFiles(...files.map(f => f.path));
        return {
          statusCode: 415,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Unsupported media type. Please upload valid image files (e.g., JPG, PNG).'
          })
        };
      }
    }

    // Generate job ID and paths
    const jobId = uuidv4();
    const inputPaths = files.map(file => `${TMP_DIR}/${jobId}_input_${file.filename}`);
    const s3InputKeys = files.map(file => `${jobId}/input/${file.filename}`);
    const outputPath = `${TMP_DIR}/${jobId}.pdf`;
    const s3OutputKey = `${jobId}/output/${jobId}.pdf`;

    // Initialize job in DynamoDB
    await updateJob(jobId, {
      status: 'uploading',
      progress: 0,
      inputFiles: files.map(f => f.filename),
      conversionType: 'image-to-pdf'
    });

    // Upload input files to S3 and download to local paths
    for (let i = 0; i < files.length; i++) {
      await uploadToS3(files[i].path, s3InputKeys[i], BUCKET_NAME);
      await downloadFromS3(s3InputKeys[i], inputPaths[i], BUCKET_NAME);
    }
    await updateJob(jobId, { status: 'processing', progress: 50 });

    // Create PDF document
    const doc = new PDFDocument();
    const writeStream = fs.createWriteStream(outputPath);

    // Handle stream errors
    writeStream.on('error', async (err) => {
      console.error(`Job ${jobId}: Write stream error - ${err}`);
      await cleanupFiles(outputPath, ...inputPaths);
      throw err;
    });

    doc.pipe(writeStream);

    // Add images to PDF
    for (let i = 0; i < inputPaths.length; i++) {
      try {
        if (i > 0) doc.addPage();
        doc.image(inputPaths[i], 0, 0, { width: doc.page.width, height: doc.page.height });
      } catch (imageError) {
        console.error(`Job ${jobId}: Error adding image ${inputPaths[i]} - ${imageError}`);
        throw imageError;
      }
    }

    // Finalize PDF
    await new Promise((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);
      doc.end();
    });

    // Ensure the stream is fully closed
    await new Promise((resolve) => writeStream.on('finish', resolve));

    // Upload output to S3
    await uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);

    // Update job progress to completed
    await updateJob(jobId, {
      jobId,
      status: 'completed',
      progress: 100,
      s3OutputKey,
      originalName: files[0].filename.split('.')[0], // Use first file's base name
      conversionType: 'image-to-pdf',
      completedAt: new Date().toISOString()
    });

    // Clean up local files
    await cleanupFiles(outputPath, ...inputPaths, ...files.map(f => f.path));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId })
    };
  } catch (error) {
    console.error(`Error in job ${jobId || 'unknown'}: ${error.message}`);
    console.error(error.stack);

    // Update job status if jobId exists
    if (typeof jobId !== 'undefined') {
      await updateJob(jobId, {
        status: 'failed',
        error: error.message,
        progress: 0
      }).catch(err => console.error(`Failed to update error status: ${err}`));
    }

    // Clean up any files that might exist
    try {
      if (typeof outputPath !== 'undefined') await cleanupFiles(outputPath);
      if (typeof inputPaths !== 'undefined') await cleanupFiles(...inputPaths);
      if (typeof files !== 'undefined') await cleanupFiles(...files.map(f => f.path));
    } catch (cleanupError) {
      console.error(`Cleanup failed: ${cleanupError}`);
    }

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to convert images to PDF.',
        requestId: context.awsRequestId
      })
    };
  }
}