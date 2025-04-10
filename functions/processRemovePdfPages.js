/**
 * Process PDF page removal in background
 */
import fs from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { updateJob } from '../lib/dynamodb.js';
import { parsePageRange } from '../lib/utils.js';

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Process removal of pages from a PDF triggered by S3 event
 * @param {object} event - S3 event
 * @returns {Promise<object>} - Response
 */
export async function handler(event) {
  const record = event.Records[0];
  const bucket = record.s3.bucket.name;
  const s3InputKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const jobId = s3InputKey.split('/')[1].split('.')[0]; // e.g., pdf/<jobId>.pdf

  // Ensure tmp directory exists
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  const localInputPath = `${TMP_DIR}/${jobId}_input.pdf`;
  const outputPath = `${TMP_DIR}/${jobId}_removed.pdf`;
  const s3OutputKey = `output/${jobId}_removed.pdf`;

  try {
    // Fetch job details to get pages and verify conversion type
    const job = await updateJob(jobId, { status: 'processing', progress: 20 }); // Assuming updateJob returns current item
    if (!job || !job.pages || job.conversionType !== 'remove-pdf-pages') {
      if (job && job.conversionType !== 'remove-pdf-pages') {
        console.log(`Job ${jobId} is not a remove-pdf-pages job, skipping`);
        return { statusCode: 200, body: 'Skipped' };
      }
      throw new Error('Job not found or missing page range');
    }
    const pages = job.pages;

    // Download PDF from S3
    await downloadFromS3(s3InputKey, localInputPath, BUCKET_NAME);

    // Load the PDF document
    const pdfBytes = fs.readFileSync(localInputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();

    // Parse page ranges to determine which pages to remove
    const pagesToRemove = new Set(parsePageRange(pages, totalPages));

    // Determine which pages to keep
    const pagesToKeep = [];
    for (let i = 0; i < totalPages; i++) {
      if (!pagesToRemove.has(i)) {
        pagesToKeep.push(i);
      }
    }

    // Create a new PDF with only the pages to keep
    const newPdf = await PDFDocument.create();
    const copiedPages = await newPdf.copyPages(pdfDoc, pagesToKeep);
    copiedPages.forEach(page => newPdf.addPage(page));

    // Save the new PDF
    const pdfBytesRemoved = await newPdf.save();
    fs.writeFileSync(outputPath, pdfBytesRemoved);

    // Upload output to S3
    await uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);

    // Update job to completed
    await updateJob(jobId, {
      status: 'completed',
      progress: 100,
      s3OutputKey,
      originalName: path.basename(s3InputKey, '.pdf'),
      pages,
      conversionType: 'remove-pdf-pages',
      completedAt: new Date().toISOString()
    });

    // Clean up local files
    await cleanupFiles(localInputPath, outputPath);

    return { statusCode: 200, body: 'Removal completed' };
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