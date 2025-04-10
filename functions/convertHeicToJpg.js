/**
 * Convert HEIC to JPG function - Queues the conversion
 */
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileTypeFromFile } from 'file-type';
import { parse } from 'lambda-multipart-parser';

import { uploadToS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { updateJob } from '../lib/dynamodb.js';

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Queue HEIC image to JPG conversion
 * @param {object} event - API Gateway event
 * @param {object} context - Lambda context
 * @returns {Promise<object>} - Response with jobId
 */
export async function handler(event, context) {
  const jobId = uuidv4();

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
    if (file.content.length > 100 * 1024 * 1024) { // Use content length for buffer
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

    // Define S3 key
    const s3InputKey = `heic/${jobId}.${fileExtension}`;

    // Initialize job in DynamoDB
    await updateJob(jobId, {
      status: 'uploading',
      progress: 0,
      inputFile: file.filename,
      conversionType: 'heic-to-jpg',
      s3InputKey,
    });

    // Upload input to S3
    await uploadToS3(file.path, s3InputKey, BUCKET_NAME);

    // Update job to processing
    await updateJob(jobId, { status: 'processing', progress: 10 });

    // Clean up local file
    await cleanupFiles(file.path);

    return {
      statusCode: 202, // Accepted, processing will continue in background
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, status: 'processing' })
    };
  } catch (error) {
    console.error(`Error queuing job ${jobId}: ${error.message}`);

    // Update job status if jobId exists
    if (jobId) {
      await updateJob(jobId, {
        status: 'failed',
        error: error.message,
        progress: 0
      }).catch(err => console.error(`Failed to update error status: ${err}`));
    }

    // Clean up if file.path exists
    try {
      if (file && file.path) await cleanupFiles(file.path);
    } catch (cleanupError) {
      console.error(`Cleanup failed: ${cleanupError}`);
    }

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to queue HEIC to JPG conversion.',
        requestId: context.awsRequestId
      })
    };
  }
}