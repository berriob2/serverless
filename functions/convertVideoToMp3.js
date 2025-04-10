/**
 * Convert video to MP3 function - Queues the conversion
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
 * Queue video to MP3 conversion
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
    const outputFormat = parsedEvent.outputFormat || 'mp3'; // Allow outputFormat as form field
    const quality = parsedEvent.quality || 'medium'; // Allow quality as form field

    if (!files || files.length === 0) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No video file uploaded.' })
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

    // Validate output format
    const supportedAudioFormats = ['mp3', 'flac', 'wav', 'ogg'];
    if (!supportedAudioFormats.includes(outputFormat)) {
      await cleanupFiles(file.path);
      return {
        statusCode: 415,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: `Unsupported output format. Supported formats: ${supportedAudioFormats.join(', ')}`
        })
      };
    }

    // Validate quality parameter
    const supportedQualities = ['low', 'medium', 'high'];
    let validatedQuality = quality;
    if (!supportedQualities.includes(quality)) {
      console.warn(`Invalid quality parameter: ${quality}. Using default 'medium' quality.`);
      validatedQuality = 'medium';
    }

    // Validate file type
    const fileExtension = path.extname(file.filename).slice(1).toLowerCase();
    const validVideoExtensions = ['mp4', 'mpeg', 'mov', 'avi', 'webm', '3gp', 'flv', 'mkv', 'wmv'];
    const validAudioExtensions = ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a'];
    const validExtensions = [...validVideoExtensions, ...validAudioExtensions];
    const detectedType = await fileTypeFromFile(file.path).catch(err => {
      console.error(`Error detecting file type: ${err.message}`);
      return null;
    });

    const validVideoMimeTypes = [
      'video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 'video/webm',
      'video/3gpp', 'video/x-flv', 'video/x-matroska', 'video/x-ms-wmv', 'audio/x-ms-asf', 'video/x-ms-asf',
    ];
    const validAudioMimeTypes = [
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav',
      'audio/flac', 'audio/ogg', 'audio/aac', 'audio/mp4', 'audio/x-m4a'
    ];
    const validMimeTypes = [...validVideoMimeTypes, ...validAudioMimeTypes];

    if (!validExtensions.includes(fileExtension) || (detectedType && !validMimeTypes.includes(detectedType.mime))) {
      await cleanupFiles(file.path);
      return {
        statusCode: 415,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Unsupported media type. Please upload a valid video or audio file.'
        })
      };
    }

    // Define S3 key
    const s3InputKey = `video-to-mp3/${jobId}.${fileExtension}`;

    // Initialize job in DynamoDB
    await updateJob(jobId, {
      status: 'uploading',
      progress: 0,
      inputFile: file.filename,
      outputFormat,
      quality: validatedQuality,
      conversionType: 'video-to-mp3',
      s3InputKey,
      fileSize: file.content.length
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
        error: 'Failed to queue video to MP3 conversion.',
        requestId: context.awsRequestId
      })
    };
  }
}