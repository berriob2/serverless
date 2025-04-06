/**
 * Convert HEIC to JPG function
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileTypeFromFile } from 'file-type';
import convert from 'heic-convert';
import { parse } from 'lambda-multipart-parser'; // Added for multipart parsing

import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { updateJob } from '../lib/dynamodb.js'; // Added for consistent job tracking

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Convert HEIC image to JPG
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
        body: JSON.stringify({ error: 'HEIC file is required.' })
      };
    }

    // Use the first file from the upload
    const file = files[0];

    // Validate file size (100 MB limit)
    if (file.size > 100 * 1024 * 1024) {
      await cleanupFiles(file.path);
      return {
        statusCode: 413,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'File exceeds 100 MB limit.' })
      };
    }

    // Validate file type
    const fileExtension = path.extname(file.filename).slice(1).toLowerCase();
    const detectedType = await fileTypeFromFile(file.path);
    const validHeicMimeTypes = ['image/heic', 'image/heif'];

    if (!['heic', 'heif'].includes(fileExtension) || !detectedType || !validHeicMimeTypes.includes(detectedType.mime)) {
      await cleanupFiles(file.path);
      return {
        statusCode: 415,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unsupported media type. Please upload a HEIC/HEIF file.' })
      };
    }

    // Generate job ID and paths
    const jobId = uuidv4();
    const s3InputKey = `${jobId}/input/${file.filename}`;
    const localInputPath = `${TMP_DIR}/${jobId}_input.${fileExtension}`;
    const outputPath = `${TMP_DIR}/${jobId}.jpg`;
    const s3OutputKey = `${jobId}/output/${jobId}.jpg`;

    // Initialize job in DynamoDB
    await updateJob(jobId, {
      status: 'uploading',
      progress: 0,
      inputFile: file.filename,
      conversionType: 'heic-to-jpg'
    });

    // Upload input to S3 and download to local path
    await uploadToS3(file.path, s3InputKey, BUCKET_NAME);
    await updateJob(jobId, { status: 'processing', progress: 50 });
    await downloadFromS3(s3InputKey, localInputPath, BUCKET_NAME);

    // Convert HEIC to JPG
    const inputBuffer = fs.readFileSync(localInputPath);
    const outputBuffer = await convert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 1 // Use maximum quality
    });

    // Save the converted image
    fs.writeFileSync(outputPath, outputBuffer);

    // Upload output to S3
    await uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);

    // Update job progress to completed
    await updateJob(jobId, {
      jobId,
      status: 'completed',
      progress: 100,
      s3OutputKey,
      originalName: path.basename(file.filename, `.${fileExtension}`),
      conversionType: 'heic-to-jpg',
      completedAt: new Date().toISOString()
    });

    // Clean up local files
    await cleanupFiles(localInputPath, outputPath, file.path);

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
      if (typeof localInputPath !== 'undefined') await cleanupFiles(localInputPath);
      if (typeof outputPath !== 'undefined') await cleanupFiles(outputPath);
      if (typeof file !== 'undefined' && file.path) await cleanupFiles(file.path);
    } catch (cleanupError) {
      console.error(`Cleanup failed: ${cleanupError}`);
    }

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to convert HEIC to JPG.',
        requestId: context.awsRequestId
      })
    };
  }
}