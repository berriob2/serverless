/**
 * Process HEIC to JPG conversion in background
 */
import fs from 'fs';
import path from 'path';
import convert from 'heic-convert';

import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { updateJob } from '../lib/dynamodb.js';

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Process HEIC to JPG conversion triggered by S3 event
 * @param {object} event - S3 event
 * @returns {Promise<object>} - Response
 */
export async function handler(event) {
  const record = event.Records[0];
  const bucket = record.s3.bucket.name;
  const s3InputKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const jobId = s3InputKey.split('/')[1].split('.')[0]; // e.g., heic/<jobId>.heic

  // Ensure tmp directory exists
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  const localInputPath = `${TMP_DIR}/${jobId}_input.heic`; // Assuming .heic extension
  const outputPath = `${TMP_DIR}/${jobId}.jpg`;
  const s3OutputKey = `output/${jobId}.jpg`;

  try {
    // Update job status
    await updateJob(jobId, { status: 'processing', progress: 20 });

    // Download file from S3
    await downloadFromS3(s3InputKey, localInputPath, BUCKET_NAME);

    // Convert HEIC to JPG
    const inputBuffer = fs.readFileSync(localInputPath);
    const outputBuffer = await convert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 1
    });

    // Save the converted image
    fs.writeFileSync(outputPath, outputBuffer);

    // Upload output to S3
    await uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);

    // Update job to completed
    await updateJob(jobId, {
      status: 'completed',
      progress: 100,
      s3OutputKey,
      originalName: path.basename(s3InputKey, path.extname(s3InputKey)),
      conversionType: 'heic-to-jpg',
      completedAt: new Date().toISOString()
    });

    // Clean up local files
    await cleanupFiles(localInputPath, outputPath);

    return { statusCode: 200, body: 'Conversion completed' };
  } catch (error) {
    console.error(`Error processing job ${jobId}: ${error.message}`);

    // Update job status to failed
    await updateJob(jobId, {
      status: 'failed',
      error: error.message,
      progress: 0
    }).catch(err => console.error(`Failed to update error status: ${err}`));

    // Clean up
    await cleanupFiles(localInputPath, outputPath).catch(cleanupError => {
      console.error(`Cleanup failed: ${cleanupError}`);
    });

    throw error; // Let Lambda retry if needed
  }
}