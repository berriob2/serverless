/**
 * Convert HEIC to JPG function
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileTypeFromFile } from 'file-type';
import convert from 'heic-convert';

import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Convert HEIC image to JPG
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
    const { file } = event;
    
    if (!file) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'HEIC file is required.' })
      };
    }
    
    // Validate file type
    const fileExtension = path.extname(file.originalname).slice(1).toLowerCase();
    const detectedType = await fileTypeFromFile(file.path);
    const validHeicMimeTypes = ['image/heic', 'image/heif'];
    
    if (!['heic', 'heif'].includes(fileExtension) || !detectedType || !validHeicMimeTypes.includes(detectedType.mime)) {
      await cleanupFiles(file.path);
      return {
        statusCode: 415,
        body: JSON.stringify({ error: 'Unsupported media type. Please upload a HEIC/HEIF file.' })
      };
    }
    
    // Generate job ID and paths
    const jobId = uuidv4();
    const s3InputKey = `${jobId}/input/${file.filename}`;
    const localInputPath = `${TMP_DIR}/${jobId}_input.${fileExtension}`;
    const outputPath = `${TMP_DIR}/${jobId}.jpg`;
    const s3OutputKey = `${jobId}/output/${jobId}.jpg`;
    
    // Upload input to S3 and download to local path
    await uploadToS3(file.path, s3InputKey, BUCKET_NAME);
    await downloadFromS3(s3InputKey, localInputPath, BUCKET_NAME);
    
    // Convert HEIC to JPG
    const inputBuffer = fs.readFileSync(localInputPath);
    const outputBuffer = await convert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 1 // Use maximum quality
    });
    
    // Save the converted image
    fs.writeFileSync(outputPath, outputBuffer);
    
    // Upload output to S3
    await uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);
    
    // Update job progress
    const jobInfo = {
      jobId,
      status: 'completed',
      s3OutputKey,
      originalName: path.basename(file.originalname, `.${fileExtension}`),
      conversionType: 'heic-to-jpg'
    };
    
    // Import and use updateJob function if available
    try {
      const { updateJob } = await import('./progress.js');
      updateJob(jobId, jobInfo);
    } catch (progressError) {
      console.warn(`Could not update job progress: ${progressError.message}`);
    }
    
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
      body: JSON.stringify({ error: 'Failed to convert HEIC to JPG.' })
    };
  }
}