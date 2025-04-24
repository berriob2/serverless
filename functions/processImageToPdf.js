/**
 * Process images to PDF conversion in background
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { S3Client } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

const s3Helpers = require('../lib/s3.js');
const { cleanupFiles } = require('../lib/cleanup.js');
const { updateJob, getJob } = require('../lib/dynamodb.js');

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

// Initialize clients
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'mx-central-1' });
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'mx-central-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Process images to PDF conversion triggered by S3 event
 * @param {object} event - S3 event
 * @returns {Promise<object>} - Response
 */
exports.handler = async function(event) {
  const record = event.Records[0];
  const bucket = record.s3.bucket.name;
  const s3InputKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  
  // Extract jobId from the S3 key - support both formats:
  // 1. image-to-pdf/<jobId>.jpg (single file trigger)
  // 2. images/<jobId>/<filename> (folder structure)
  let jobId;
  if (s3InputKey.startsWith('image-to-pdf/')) {
    jobId = s3InputKey.split('/')[1].split('.')[0];
  } else if (s3InputKey.startsWith('images/')) {
    const parts = s3InputKey.split('/');
    if (parts.length >= 2) {
      jobId = parts[1];
    }
  } else {
    console.log(`Unrecognized S3 key format: ${s3InputKey}`);
    return { statusCode: 400, body: 'Invalid S3 key format' };
  }

  if (!jobId) {
    console.error('Could not extract jobId from S3 key:', s3InputKey);
    return { statusCode: 400, body: 'Could not extract jobId' };
  }

  // Ensure tmp directory exists
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  const outputPath = `${TMP_DIR}/${jobId}.pdf`;
  const s3OutputKey = `output/${jobId}.pdf`;
  let inputPaths = [];

  try {
    // Update job status
    await updateJob(jobId, { status: 'processing', progress: 20 });

    // Fetch job details to get all input keys
    const job = await getJob(jobId);
    console.log(`Job details for ${jobId}:`, JSON.stringify(job));
    
    let s3InputKeys = [];
    
    // Handle different job structures
    if (job && job.s3InputKeys && Array.isArray(job.s3InputKeys)) {
      // Standard format with array of input keys
      s3InputKeys = job.s3InputKeys;
    } else if (job && job.s3InputKey) {
      // Alternative format with single input key
      s3InputKeys = [job.s3InputKey];
    } else if (s3InputKey) {
      // Fallback: use the triggering S3 key itself
      s3InputKeys = [s3InputKey];
      
      // Update the job with this key if possible
      if (job) {
        await updateJob(jobId, { s3InputKeys: [s3InputKey] });
      }
    }
    
    if (s3InputKeys.length === 0) {
      throw new Error(`No input files found for job ${jobId}`);
    }
    
    inputPaths = s3InputKeys.map(key => `${TMP_DIR}/${jobId}_${path.basename(key)}`);

    // Download all images from S3
    for (let i = 0; i < s3InputKeys.length; i++) {
      await s3Helpers.downloadFromS3(s3InputKeys[i], inputPaths[i], BUCKET_NAME);
    }

    // Create PDF document
    const doc = new PDFDocument();
    const writeStream = fs.createWriteStream(outputPath);

    writeStream.on('error', async (err) => {
      console.error(`Job ${jobId}: Write stream error - ${err}`);
      await cleanupFiles(outputPath, ...inputPaths);
      throw err;
    });

    doc.pipe(writeStream);

    // Add images to PDF
    for (let i = 0; i < inputPaths.length; i++) {
      if (i > 0) doc.addPage();
      doc.image(inputPaths[i], 0, 0, { width: doc.page.width, height: doc.page.height });
    }

    // Finalize PDF
    await new Promise((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);
      doc.end();
    });

    await new Promise((resolve) => writeStream.on('finish', resolve));

    // Upload output to S3
    await updateJob(jobId, { status: 'uploading', progress: 95 });
    await s3Helpers.uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);

    // Update job to completed
    await updateJob(jobId, {
      status: 'completed',
      progress: 100,
      s3OutputKey,
      originalName: path.basename(s3InputKeys[0], path.extname(s3InputKeys[0])), // Use first file's base name
      conversionType: 'image-to-pdf',
      completedAt: new Date().toISOString()
    });

    // Clean up local files
    await cleanupFiles(outputPath, ...inputPaths);

    return { statusCode: 200, body: 'Conversion completed' };
  } catch (error) {
    console.error(`Error processing job ${jobId}: ${error.message}`);

    // Update job status to failed
    await updateJob(jobId, {
      status: 'failed',
      error: error.message,
      progress: 0
    }).catch(err => console.error(`Failed to update error status: ${err}`));

    // Clean up safely
    const filesToClean = [outputPath];
    if (inputPaths.length > 0) {
      filesToClean.push(...inputPaths);
    }
    await cleanupFiles(...filesToClean).catch(cleanupError => {
      console.error(`Cleanup failed: ${cleanupError}`);
    });

    throw error; // Let Lambda retry if needed
  }
};