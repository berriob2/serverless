/**
 * Extract PDF Pages function - Queues the extraction
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
 * Queue extraction of pages from a PDF document
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
    const pages = parsedEvent.pages; // Expect pages as a form field

    if (!files || files.length === 0 || !pages) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'PDF file and page range are required.' })
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
    const validPdfMimeTypes = ['application/pdf'];

    if (fileExtension !== 'pdf' || !detectedType || !validPdfMimeTypes.includes(detectedType.mime)) {
      await cleanupFiles(file.path);
      return {
        statusCode: 415,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unsupported media type. Please upload a PDF file.' })
      };
    }

    // Define S3 key
    const s3InputKey = `pdf/${jobId}.pdf`;

    // Initialize job in DynamoDB
    await updateJob(jobId, {
      status: 'uploading',
      progress: 0,
      inputFile: file.filename,
      pages,
      conversionType: 'extract-pdf-pages',
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

    // Clean up if file exists
    try {
      if (file && file.path) await cleanupFiles(file.path);
    } catch (cleanupError) {
      console.error(`Cleanup failed: ${cleanupError}`);
    }

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to queue PDF page extraction.',
        requestId: context.awsRequestId
      })
    };
  }
}