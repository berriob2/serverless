/**
 * Convert video to MP3 function
 */
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileTypeFromFile } from 'file-type';

import { parseTimemark, getDuration } from '../lib/utils.js';
import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';

// Set FFmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Convert video to MP3
 * @param {object} event - HTTP event
 * @param {object} context - Lambda context
 * @returns {Promise<object>} - Response
 */
export async function handler(event, context) {
  // Ensure tmp directory exists
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
  
  try {
    const { file, outputFormat = 'mp3' } = event;
    
    if (!file) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No video file uploaded.' })
      };
    }
    
    const supportedAudioFormats = ['mp3', 'flac'];
    if (!supportedAudioFormats.includes(outputFormat)) {
      return {
        statusCode: 415,
        body: JSON.stringify({
          error: `Unsupported output format. Supported formats: ${supportedAudioFormats.join(', ')}`
        })
      };
    }
    
    // Validate file type
    const fileExtension = path.extname(file.originalname).slice(1).toLowerCase();
    const validVideoExtensions = ['mp4', 'mpeg', 'mov', 'avi', 'webm', '3gp', 'flv', 'mkv', 'wmv'];
    const detectedType = await fileTypeFromFile(file.path);
    const validVideoMimeTypes = [
      'video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 'video/webm',
      'video/3gpp', 'video/x-flv', 'video/x-matroska', 'video/x-ms-wmv', 'audio/x-ms-asf', 'video/x-ms-asf',
    ];
    
    if (!validVideoExtensions.includes(fileExtension) || !detectedType || !validVideoMimeTypes.includes(detectedType.mime)) {
      await cleanupFiles(file.path);
      return {
        statusCode: 415,
        body: JSON.stringify({
          error: 'Unsupported media type. Please upload a valid video file (e.g., MP4, MOV, AVI).'
        })
      };
    }
    
    // Generate job ID and paths
    const jobId = uuidv4();
    const s3InputKey = `${jobId}/input/${file.filename}`;
    const localInputPath = `${TMP_DIR}/${jobId}_input.${fileExtension}`;
    const outputPath = `${TMP_DIR}/${jobId}.${outputFormat}`;
    const s3OutputKey = `${jobId}/output/${jobId}.${outputFormat}`;
    
    // Upload input to S3 and download to local path
    await uploadToS3(file.path, s3InputKey, BUCKET_NAME);
    await downloadFromS3(s3InputKey, localInputPath, BUCKET_NAME);
    
    // Get video duration
    const duration = await getDuration(localInputPath, ffmpeg);
    
    // Convert video to audio
    await new Promise((resolve, reject) => {
      ffmpeg(localInputPath)
        .audioBitrate(128)
        .format(outputFormat)
        .on('progress', (progress) => {
          const currentTime = parseTimemark(progress.timemark);
          const percent = Math.min((currentTime / duration) * 100, 100);
          console.log(`Job ${jobId}: Progress ${percent}%`);
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
    await uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);
    
    // Clean up local files
    await cleanupFiles(localInputPath, outputPath, file.path);
    
    return {
      statusCode: 200,
      body: JSON.stringify({ jobId })
    };
  } catch (error) {
    console.error(`Error: ${error}`);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to convert video to audio.' })
    };
  }
}