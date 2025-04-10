/**
 * Process images to PDF conversion in background
 */
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { updateJob } from '../lib/dynamodb.js';

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Process images to PDF conversion triggered by S3 event
 * @param {object} event - S3 event
 * @returns {Promise<object>} - Response
 */
export async function handler(event) {
  const record = event.Records[0];
  const bucket = record.s3.bucket.name;
  const s3TriggerKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const jobId = s3TriggerKey.split('/')[1]; // e.g., images/<jobId>/<filename>

  // Ensure tmp directory exists
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  const outputPath = `${TMP_DIR}/${jobId}.pdf`;
  const s3OutputKey = `output/${jobId}.pdf`;

  try {
    // Fetch job details to get all input keys
    const job = await updateJob(jobId, { status: 'processing', progress: 20 }); // Assuming updateJob returns current item
    if (!job || !job.s3InputKeys) {
      throw new Error('Job not found or missing input keys');
    }
    const s3InputKeys = job.s3InputKeys;
    const inputPaths = s3InputKeys.map(key => `${TMP_DIR}/${jobId}_${path.basename(key)}`);

    // Download all images from S3
    for (let i = 0; i < s3InputKeys.length; i++) {
      await downloadFromS3(s3InputKeys[i], inputPaths[i], BUCKET_NAME);
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
    await uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);

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

    // Clean up
    await cleanupFiles(outputPath, ...inputPaths).catch(cleanupError => {
      console.error(`Cleanup failed: ${cleanupError}`);
    });

    throw error; // Let Lambda retry if needed
  }
}