/**
 * Convert Word to PDF function - Queues the conversion
 */
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileTypeFromFile } from 'file-type';
import { parse } from 'lambda-multipart-parser';
import fs from 'fs/promises';

import { uploadToS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { updateJob } from '../lib/dynamodb.js';

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Queue conversion of Word to PDF
 * @param {object} event - API Gateway event
 * @param {object} context - Lambda context
 * @returns {Promise<object>} - Response with jobId
 */
export async function handler(event, context) {
  const jobId = uuidv4();
  let tempFilePath = null;

  try {
    // Parse multipart/form-data
    const parsedEvent = await parse(event);
    const files = parsedEvent.files;

    if (!files || files.length === 0) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No file uploaded.' }),
      };
    }

    const file = files[0];

    // Validate file size (e.g., 10 MB limit)
    if (file.content.length > 10 * 1024 * 1024) {
      return {
        statusCode: 413,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'File too large. Maximum file size is 10MB.' }),
      };
    }

    // Write file to disk for validation
    tempFilePath = path.join(TMP_DIR, `${jobId}-${file.filename}`);
    await fs.writeFile(tempFilePath, file.content);

    // Validate file type
    const fileExtension = path.extname(file.filename).slice(1).toLowerCase();
    const detectedType = await fileTypeFromFile(tempFilePath);
    const validDocxMimeTypes = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

    if (fileExtension !== 'docx' || !detectedType || !validDocxMimeTypes.includes(detectedType.mime)) {
      await cleanupFiles(tempFilePath);
      return {
        statusCode: 415,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unsupported media type. Please upload a .docx file.' }),
      };
    }

    // Define S3 key
    const s3InputKey = `word-to-pdf/${jobId}.docx`;

    // Initialize job in DynamoDB
    await updateJob(jobId, {
      status: 'uploading',
      progress: 0,
      inputFile: file.filename,
      conversionType: 'word-to-pdf',
      s3InputKey,
    });

    // Upload input to S3
    await uploadToS3(tempFilePath, s3InputKey, BUCKET_NAME);

    // Update job to processing
    await updateJob(jobId, { status: 'processing', progress: 10 });

    // Clean up local file
    await cleanupFiles(tempFilePath);

    return {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, status: 'processing' }),
    };
  } catch (error) {
    console.error(`Error queuing job ${jobId}: ${error.message}`);

    if (jobId) {
      await updateJob(jobId, {
        status: 'failed',
        error: error.message,
        progress: 0,
      }).catch((err) => console.error(`Failed to update error status: ${err}`));
    }

    if (tempFilePath) {
      await cleanupFiles(tempFilePath).catch((cleanupError) => {
        console.error(`Cleanup failed: ${cleanupError}`);
      });
    }

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to queue Word to PDF conversion.',
        requestId: context.awsRequestId,
      }),
    };
  }
}