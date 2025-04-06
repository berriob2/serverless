/**
 * Convert video to MP3 function
 */
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileTypeFromFile } from 'file-type';
import { parse } from 'lambda-multipart-parser'; // Added for multipart parsing

import { parseTimemark, getDuration, truncateFileName } from '../lib/utils.js';
import { uploadToS3, downloadFromS3, getSignedDownloadUrl } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { updateJob, getJob } from '../lib/dynamodb.js';

// Set FFmpeg path
ffmpeg.setFmpegPath(ffmpegInstaller.path);

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Convert video to MP3
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
    console.log('Event received:', JSON.stringify(event, null, 2));

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
    if (file.size > 100 * 1024 * 1024) {
      await cleanupFiles(file.path);
      return {
        statusCode: 413,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'File exceeds 100 MB limit.' })
      };
    }

    const supportedAudioFormats = ['mp3', 'flac', 'wav', 'ogg'];
    if (!supportedAudioFormats.includes(outputFormat)) {
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

    if (!validExtensions.includes(fileExtension)) {
      await cleanupFiles(file.path);
      return {
        statusCode: 415,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: `Unsupported file extension: .${fileExtension}. Please upload a valid video or audio file.`
        })
      };
    }

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
    if (detectedType && !validMimeTypes.includes(detectedType.mime)) {
      await cleanupFiles(file.path);
      return {
        statusCode: 415,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: `Unsupported media type: ${detectedType.mime}. Please upload a valid video or audio file.`
        })
      };
    }

    // Generate job ID and paths
    const jobId = uuidv4();
    const safeFilename = truncateFileName(file.filename || 'unknown');
    const s3InputKey = `${jobId}/input/${safeFilename}`;
    const localInputPath = `${TMP_DIR}/${jobId}_input.${fileExtension}`;
    const outputPath = `${TMP_DIR}/${jobId}.${outputFormat}`;
    const s3OutputKey = `${jobId}/output/${jobId}.${outputFormat}`;

    // Create initial job record
    await updateJob(jobId, {
      status: 'uploading',
      progress: 0,
      inputFile: safeFilename,
      outputFormat,
      quality: validatedQuality,
      s3InputKey,
      s3OutputKey,
      fileSize: file.size
    });

    // Upload input to S3 and download to local path
    try {
      await updateJob(jobId, { status: 'uploading', progress: 10 });
      await uploadToS3(file.path, s3InputKey, BUCKET_NAME);
      await updateJob(jobId, { status: 'processing', progress: 20 });
      await downloadFromS3(s3InputKey, localInputPath, BUCKET_NAME);
    } catch (uploadError) {
      console.error(`S3 operation failed for job ${jobId}:`, uploadError);
      await updateJob(jobId, { status: 'failed', error: 'Failed to upload or download file' });
      await cleanupFiles(file.path);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Failed to process file. Please try again.' })
      };
    }

    // Get video duration
    let duration;
    try {
      duration = await getDuration(localInputPath, ffmpeg);
      await updateJob(jobId, { duration, progress: 25 });
    } catch (durationError) {
      console.error(`Failed to get duration for job ${jobId}:`, durationError);
      await updateJob(jobId, { status: 'failed', error: 'Failed to analyze media file' });
      await cleanupFiles(localInputPath, file.path);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Failed to analyze media file. The file may be corrupted.' })
      };
    }

    // Convert video to audio with quality settings
    await new Promise((resolve, reject) => {
      let ffmpegCommand = ffmpeg(localInputPath).format(outputFormat);

      // Apply quality settings
      switch (validatedQuality) {
        case 'low':
          ffmpegCommand.audioBitrate('64k');
          break;
        case 'high':
          ffmpegCommand.audioBitrate('256k');
          break;
        case 'medium':
        default:
          ffmpegCommand.audioBitrate('128k');
          break;
      }

      ffmpegCommand
        .audioChannels(2)
        .audioFrequency(44100)
        .on('start', (commandLine) => {
          console.log(`Job ${jobId}: FFmpeg command: ${commandLine}`);
          updateJob(jobId, {
            status: 'processing',
            progress: 30,
            commandLine
          }).catch(err => console.error(`Failed to update job start status: ${err}`));
        })
        .on('progress', async (progress) => {
          try {
            const currentTime = parseTimemark(progress.timemark);
            const percent = 30 + Math.min((currentTime / duration) * 60, 60); // Scale from 30% to 90%
            console.log(`Job ${jobId}: Progress ${percent.toFixed(1)}% (${progress.timemark} / ${duration.toFixed(1)}s)`);
            await updateJob(jobId, { progress, currentTime });
          } catch (progressError) {
            console.warn(`Failed to update progress for job ${jobId}:`, progressError);
          }
        })
        .on('end', async () => {
          console.log(`Job ${jobId}: Conversion completed`);
          try {
            await updateJob(jobId, { status: 'completed', progress: 90 });
            resolve();
          } catch (endError) {
            console.error(`Failed to update job completion status: ${endError}`);
            resolve(); // Continue despite update failure
          }
        })
        .on('error', async (err) => {
          console.error(`Job ${jobId}: FFmpeg Error - ${err}`);
          await updateJob(jobId, { status: 'failed', error: err.message });
          reject(err);
        })
        .save(outputPath);
    }).catch(async (conversionError) => {
      console.error(`Conversion failed for job ${jobId}:`, conversionError);
      await cleanupFiles(localInputPath, outputPath, file.path);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Failed to convert media file. Please try again.' })
      };
    });

    // Upload output to S3
    try {
      await updateJob(jobId, { status: 'uploading', progress: 95 });
      await uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);

      // Generate a pre-signed URL for immediate download
      const downloadUrl = await getSignedDownloadUrl(s3OutputKey, BUCKET_NAME, 3600);

      // Update job with final status and download URL
      await updateJob(jobId, {
        status: 'completed',
        progress: 100,
        downloadUrl,
        completedAt: new Date().toISOString()
      });

      // Clean up local files
      await cleanupFiles(localInputPath, outputPath, file.path);

      // Get the complete job information to return
      const jobInfo = await getJob(jobId);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          status: 'completed',
          downloadUrl,
          s3OutputKey,
          outputFormat,
          quality: validatedQuality,
          duration: jobInfo?.duration || duration
        })
      };
    } catch (finalError) {
      console.error(`Final processing failed for job ${jobId}:`, finalError);
      await updateJob(jobId, { status: 'failed', error: 'Failed to upload converted file', progress: 0 })
        .catch(err => console.error(`Failed to update final error status: ${err}`));
      await cleanupFiles(localInputPath, outputPath, file.path);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Failed to complete conversion process. Please try again.' })
      };
    }
  } catch (error) {
    console.error(`Unhandled error in convertVideoToMp3: ${error.message}`);
    console.error(error.stack);

    // Update job status if jobId exists
    if (typeof jobId !== 'undefined') {
      await updateJob(jobId, {
        status: 'failed',
        error: 'Internal server error',
        errorDetails: error.message,
        progress: 0
      }).catch(err => console.error(`Failed to update error status: ${err}`));
    }

    // Clean up any files that might exist
    try {
      if (typeof localInputPath !== 'undefined') await cleanupFiles(localInputPath);
      if (typeof outputPath !== 'undefined') await cleanupFiles(outputPath);
      if (typeof file !== 'undefined' && file.path) await cleanupFiles(file.path);
    } catch (cleanupError) {
      console.error(`Failed to clean up files: ${cleanupError}`);
    }

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to convert video to audio due to an internal server error.',
        requestId: context.awsRequestId
      })
    };
  }
}