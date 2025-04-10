/**
 * Download converted file function
 */
import path from 'path';
import { getSignedDownloadUrl } from '../lib/s3.js';
import { getJob } from '../lib/dynamodb.js';

// Configuration
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Download converted file
 * @param {object} event - HTTP event
 * @param {object} context - Lambda context
 * @returns {Promise<object>} - Response
 */
export async function handler(event, context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*', // CORS header for browser access
    'Cache-Control': 'no-cache'
  };

  try {
    const { jobId } = event.queryStringParameters || {};
    
    if (!jobId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Job ID is required.' })
      };
    }
    
    // Get job information with timeout
    const job = await Promise.race([
      getJob(jobId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Job retrieval timeout')), 5000)) // 5s timeout
    ]);
    
    if (!job || job.status !== 'completed') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'File not found or not ready' })
      };
    }
    
    // Get S3 output key from job
    const s3OutputKey = job.s3OutputKey;
    if (!s3OutputKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Output file information not found' })
      };
    }
    
    // Determine filename based on job context
    const extension = path.extname(s3OutputKey).slice(1);
    let filename = job.originalName ? `${job.originalName}` : 'converted_file';
    
    // Enhance filename with conversionType if available
    if (job.conversionType) {
      switch (job.conversionType) {
        case 'heic-to-jpg': filename += '_converted'; break;
        case 'pdf-to-word': filename += '_word'; break;
        case 'video-to-mp3': filename += '_audio'; break;
        case 'video': filename += '_converted'; break;
        case 'image-to-pdf': filename += '_pdf'; break;
        case 'extract-pdf-pages': filename += '_extracted'; break;
        case 'remove-pdf-pages': filename += '_trimmed'; break;
        default: break;
      }
    }
    filename += `.${extension}`;
    
    // Generate pre-signed URL for download with timeout
    const downloadUrl = await Promise.race([
      getSignedDownloadUrl(s3OutputKey, BUCKET_NAME, 3600, {
        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(filename)}"`
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('S3 URL generation timeout')), 5000)) // 5s timeout
    ]);
    
    // Return success response with download URL
    return {
      statusCode: 200,
      headers,
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
      headers,
      body: JSON.stringify({
        error: 'Failed to generate download link',
        message: error.message,
        requestId: context.awsRequestId
      })
    };
  }
}