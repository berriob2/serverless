/**
 * Convert images to PDF function
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileTypeFromFile } from 'file-type';
import PDFDocument from 'pdfkit';

import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Convert images to PDF
 * @param {object} event - HTTP event
 * @param {object} context - Lambda context
 * @returns {Promise<object>} - Response
 */
export async function handler(event, context) {
  // Ensure tmp directory exists
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
  
  try {
    const { files } = event;
    
    if (!files || files.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No images uploaded.' })
      };
    }
    
    // Validate file types
    const validImageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff'];
    const validImageMimeTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', 'image/tiff',
    ];
    
    for (const file of files) {
      const fileExtension = path.extname(file.originalname).slice(1).toLowerCase();
      const detectedType = await fileTypeFromFile(file.path);
      if (!validImageExtensions.includes(fileExtension) || !detectedType || !validImageMimeTypes.includes(detectedType.mime)) {
        await cleanupFiles(...files.map(f => f.path));
        return {
          statusCode: 415,
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
    
    // Upload input files to S3 and download to local paths
    for (let i = 0; i < files.length; i++) {
      await uploadToS3(files[i].path, s3InputKeys[i], BUCKET_NAME);
      await downloadFromS3(s3InputKeys[i], inputPaths[i], BUCKET_NAME);
    }
    
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
    
    // Clean up local files
    await cleanupFiles(outputPath, ...inputPaths, ...files.map(f => f.path));
    
    return {
      statusCode: 200,
      body: JSON.stringify({ jobId })
    };
  } catch (error) {
    console.error(`Error: ${error}`);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to convert images to PDF.' })
    };
  }
}