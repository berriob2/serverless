/**
 * Process video conversion in background
 */
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { updateJob } from '../lib/dynamodb.js';
import { getDuration, parseTimemark } from '../lib/utils.js';

// Set FFmpeg path
ffmpeg.setFmpegPath(ffmpegInstaller.path);

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Process video conversion triggered by S3 event
 * @param {object} event - S3 event
 * @returns {Promise<object>} - Response
 */
export async function handler(event) {
  const record = event.Records[0];
  const bucket = record.s3.bucket.name;
  const s3InputKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const jobId = s3InputKey.split('/')[1].split('.')[0]; // e.g., videos/<jobId>.mp4

  // Ensure tmp directory exists
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  const localInputPath = `${TMP_DIR}/${jobId}_input${path.extname(s3InputKey)}`;
  let outputPath, s3OutputKey;

  try {
    // Fetch job details to get output format
    const job = await updateJob(jobId, { status: 'processing', progress: 20 }); // Assuming updateJob returns current item
    if (!job || !job.outputFormat) {
      throw new Error('Job not found or missing output format');
    }
    const outputFormat = job.outputFormat;

    outputPath = `${TMP_DIR}/${jobId}.${outputFormat}`;
    s3OutputKey = `output/${jobId}.${outputFormat}`;

    // Download video from S3
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
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });

    // Upload output to S3
    await updateJob(jobId, { status: 'uploading', progress: 95 });
    await uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);

    // Update job to completed
    await updateJob(jobId, {
      status: 'completed',
      progress: 100,
      s3OutputKey,
      originalName: path.basename(s3InputKey, path.extname(s3InputKey)),
      conversionType: 'video',
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