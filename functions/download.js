/**
 * Download converted file function
 */
import path from 'path';
import { getSignedDownloadUrl } from '../lib/s3.js';
import { getJob } from './progress.js';

// Configuration
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Download converted file
 * @param {object} event - HTTP event
 * @param {object} context - Lambda context
 * @returns {Promise<object>} - Response
 */
export async function handler(event, context) {
  try {
    const { jobId } = event.queryStringParameters || {};
    
    if (!jobId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Job ID is required.' })
      };
    }
    
    // Get job information
    const job = getJob(jobId);
    
    if (!job || job.status !== 'completed') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'File not found or not ready' })
      };
    }
    
    // Get S3 output key from job
    const s3OutputKey = job.s3OutputKey;
    if (!s3OutputKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Output file information not found' })
      };
    }
    
    // Determine filename based on job context
    let filename = 'converted_file';
    if (s3OutputKey.includes('.mp4')) filename = 'video.mp4';
    else if (s3OutputKey.includes('.mp3')) filename = 'audio.mp3';
    else if (s3OutputKey.includes('.flac')) filename = 'audio.flac';
    else if (s3OutputKey.includes('.pdf')) filename = 'document.pdf';
    else if (s3OutputKey.includes('.docx')) filename = 'document.docx';
    else if (s3OutputKey.includes('.jpg')) filename = 'image.jpg';
    
    // If job has original filename, use it as a base
    if (job.originalName) {
      const extension = path.extname(s3OutputKey).slice(1);
      filename = `${job.originalName}.${extension}`;
    }
    
    // Generate pre-signed URL for download
    const downloadUrl = await getSignedDownloadUrl(s3OutputKey, BUCKET_NAME, 3600, {
      // Set content disposition to force download with the correct filename
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(filename)}"`
    });
    
    // Return success response with download URL
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // CORS header for browser access
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify({
        downloadUrl,
        filename,
        expiresIn: 3600 // URL expiration in seconds
      })
    };
  } catch (error) {
    console.error('Download error:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to generate download link',
        message: error.message
      })
    };
  }
}