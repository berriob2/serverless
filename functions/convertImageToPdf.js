/**
 * Convert images to PDF function - Queues the conversion
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
 * Queue images to PDF conversion
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
        body: JSON.stringify({ error: 'No images uploaded.' })
      };
    }

    // Validate file sizes (100 MB limit per file)
    for (const file of files) {
      if (file.content.length > 100 * 1024 * 1024) { // Use content length for buffer
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

    // Define S3 keys for input files
    const s3InputKeys = files.map(file => `images/${jobId}/${path.basename(file.filename)}`);

    // Initialize job in DynamoDB
    await updateJob(jobId, {
      status: 'uploading',
      progress: 0,
      inputFiles: files.map(f => f.filename),
      conversionType: 'image-to-pdf',
      s3InputKeys,
    });

    // Upload input files to S3
    for (let i = 0; i < files.length; i++) {
      await uploadToS3(Buffer.from(''), `images/${jobId}/done.txt`, BUCKET_NAME);
    }

    // Update job to processing
    await updateJob(jobId, { status: 'processing', progress: 10 });

    // Clean up local files
    await cleanupFiles(...files.map(f => f.path));

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

    // Clean up if files exist
    try {
      if (files && files.length > 0) await cleanupFiles(...files.map(f => f.path));
    } catch (cleanupError) {
      console.error(`Cleanup failed: ${cleanupError}`);
    }

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to queue image to PDF conversion.',
        requestId: context.awsRequestId
      })
    };
  }
}