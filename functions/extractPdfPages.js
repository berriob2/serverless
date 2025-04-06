/**
 * Extract PDF Pages function
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileTypeFromFile } from 'file-type';
import { PDFDocument } from 'pdf-lib';
import { parse } from 'lambda-multipart-parser'; // Added for multipart parsing

import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { parsePageRange } from '../lib/utils.js';
import { updateJob } from '../lib/dynamodb.js'; // Added for consistent job tracking

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Extract pages from a PDF document
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
    const pages = parsedEvent.pages; // Expect pages as a form field

    if (!files || files.length === 0 || !pages) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'PDF file and page range are required.' })
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

    // Validate file type
    const fileExtension = path.extname(file.filename).slice(1).toLowerCase();
    const detectedType = await fileTypeFromFile(file.path);
    const validPdfMimeTypes = ['application/pdf'];

    if (fileExtension !== 'pdf' || !detectedType || !validPdfMimeTypes.includes(detectedType.mime)) {
      await cleanupFiles(file.path);
      return {
        statusCode: 415,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unsupported media type. Please upload a PDF file.' })
      };
    }

    // Generate job ID and paths
    const jobId = uuidv4();
    const s3InputKey = `${jobId}/input/${file.filename}`;
    const localInputPath = `${TMP_DIR}/${jobId}_input.pdf`;
    const outputPath = `${TMP_DIR}/${jobId}_extracted.pdf`;
    const s3OutputKey = `${jobId}/output/${jobId}_extracted.pdf`;

    // Initialize job in DynamoDB
    await updateJob(jobId, {
      status: 'uploading',
      progress: 0,
      inputFile: file.filename,
      pages,
      conversionType: 'extract-pdf-pages'
    });

    // Upload input to S3 and download to local path
    await uploadToS3(file.path, s3InputKey, BUCKET_NAME);
    await updateJob(jobId, { status: 'processing', progress: 50 });
    await downloadFromS3(s3InputKey, localInputPath, BUCKET_NAME);

    // Load the PDF document
    const pdfBytes = fs.readFileSync(localInputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();

    // Parse page ranges to determine which pages to extract
    try {
      const pagesToExtract = parsePageRange(pages, totalPages);

      // Create a new PDF with only the extracted pages
      const newPdf = await PDFDocument.create();
      const copiedPages = await newPdf.copyPages(pdfDoc, pagesToExtract);
      copiedPages.forEach(page => newPdf.addPage(page));

      // Save the new PDF
      const pdfBytesExtracted = await newPdf.save();
      fs.writeFileSync(outputPath, pdfBytesExtracted);

      // Upload output to S3
      await uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);

      // Update job progress to completed
      await updateJob(jobId, {
        jobId,
        status: 'completed',
        progress: 100,
        s3OutputKey,
        originalName: path.basename(file.filename, '.pdf'),
        pages,
        conversionType: 'extract-pdf-pages',
        completedAt: new Date().toISOString()
      });

      // Clean up local files
      await cleanupFiles(localInputPath, outputPath, file.path);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId })
      };
    } catch (pageRangeError) {
      console.error(`Error parsing page range: ${pageRangeError.message}`);
      await updateJob(jobId, { status: 'failed', error: pageRangeError.message, progress: 0 });
      await cleanupFiles(localInputPath, file.path);
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: pageRangeError.message })
      };
    }
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
        error: 'Failed to extract PDF pages.',
        requestId: context.awsRequestId
      })
    };
  }
}