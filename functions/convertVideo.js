/**
 * Convert video to different formats function
 */
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileTypeFromFile } from 'file-type';
import { parse } from 'lambda-multipart-parser'; // Added for multipart parsing

import { parseTimemark, getDuration } from '../lib/utils.js';
import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { updateJob } from '../lib/dynamodb.js'; // Added for consistent job tracking

// Set FFmpeg path
ffmpeg.setFmpegPath(ffmpegInstaller.path);

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Convert video to different format
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
    const outputFormat = parsedEvent.outputFormat || 'mp4'; // Allow outputFormat as form field

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
    if (file.size > 100 * 1024 * 1024) {
      await cleanupFiles(file.path);
      return {
        statusCode: 413,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'File exceeds 100 MB limit.' })
      };
    }

    const supportedFormats = ['mp4', 'avi', 'mov', 'webm', 'wmv', '3gp', 'flv'];
    if (!supportedFormats.includes(outputFormat)) {
      return {
        statusCode: 415,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: `Unsupported output format. Supported formats: ${supportedFormats.join(', ')}`
        })
      };
    }

    // Validate file type
    const fileExtension = path.extname(file.filename).slice(1).toLowerCase();
    const validVideoExtensions = ['mp4', 'mpeg', 'mov', 'avi', 'webm', '3gp', 'flv', 'mkv', 'wmv'];
    const detectedType = await fileTypeFromFile(file.path);
    const validVideoMimeTypes = [
      'video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 'video/webm',
      'video/3gpp', 'video/x-flv', 'video/x-matroska', 'video/x-ms-wmv', 'audio/x-ms-asf', 'video/x-ms-asf',
    ];

    const isValidMime = detectedType && validVideoMimeTypes.includes(detectedType.mime);
    if (!validVideoExtensions.includes(fileExtension) || !isValidMime) {
      await cleanupFiles(file.path);
      return {
        statusCode: 415,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Unsupported media type. Please upload a valid video file.'
        })
      };
    }

    // Generate job ID and paths
    const jobId = uuidv4();
    const s3InputKey = `${jobId}/input/${file.filename}`;
    const localInputPath = `${TMP_DIR}/${jobId}_input.${fileExtension}`;
    const outputPath = `${TMP_DIR}/${jobId}.${outputFormat}`;
    const s3OutputKey = `${jobId}/output/${jobId}.${outputFormat}`;
    const originalName = path.basename(file.filename, path.extname(file.filename));

    // Initialize job in DynamoDB
    await updateJob(jobId, {
      status: 'uploading',
      progress: 0,
      inputFile: file.filename,
      outputFormat,
      conversionType: 'video'
    });

    // Upload input to S3 and download to local path
    await uploadToS3(file.path, s3InputKey, BUCKET_NAME);
    await updateJob(jobId, { status: 'processing', progress: 20 });
    await downloadFromS3(s3InputKey, localInputPath, BUCKET_NAME);

    // Get video duration
    const duration = await getDuration(localInputPath, ffmpeg);
    await updateJob(jobId, { duration, progress: 25 });

    // Convert video
    await new Promise((resolve, reject) => {
      let ffmpegCommand = ffmpeg(localInputPath);

      if (outputFormat === '3gp') {
        ffmpegCommand
          .videoCodec('h263')
          .size('176x144')
          .videoBitrate('128k')
          .audioCodec('aac')
          .audioBitrate('64k');
      } else {
        ffmpegCommand
          .videoCodec('libx264')
          .audioCodec('aac');
      }

      ffmpegCommand
        .format(outputFormat)
        .on('start', (commandLine) => {
          console.log(`Job ${jobId}: FFmpeg command: ${commandLine}`);
          updateJob(jobId, { commandLine }).catch(err => console.error(`Failed to update command: ${err}`));
        })
        .on('progress', async (progress) => {
          const currentTime = parseTimemark(progress.timemark);
          const percent = 25 + Math.min((currentTime / duration) * 65, 65); // Scale from 25% to 90%
          console.log(`Job ${jobId}: Progress ${percent.toFixed(1)}%`);
          await updateJob(jobId, { progress, currentTime }).catch(err => console.error(`Progress update failed: ${err}`));
        })
        .on('end', () => {
          console.log(`Job ${jobId}: Conversion completed`);
          resolve();
        })
        .on('error', (err) => {
          console.error(`Job ${jobId}: FFmpeg Error - ${err}`);
          reject(err);
        })
        .save(outputPath);
    });

    // Upload output to S3
    await updateJob(jobId, { status: 'uploading', progress: 95 });
    await uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);

    // Update job progress to completed
    await updateJob(jobId, {
      jobId,
      status: 'completed',
      progress: 100,
      s3OutputKey,
      originalName,
      conversionType: 'video',
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
        error: 'Failed to convert video.',
        requestId: context.awsRequestId
      })
    };
  }
}