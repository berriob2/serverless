/**
 * Remove PDF Pages function
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileTypeFromFile } from 'file-type';
import { PDFDocument } from 'pdf-lib';

import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { parsePageRange } from '../lib/utils.js';

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Remove pages from a PDF document
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
    const { file, pages } = event;
    
    if (!file || !pages) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'PDF file and page range are required.' })
      };
    }
    
    // Validate file type
    const fileExtension = path.extname(file.originalname).slice(1).toLowerCase();
    const detectedType = await fileTypeFromFile(file.path);
    const validPdfMimeTypes = ['application/pdf'];
    
    if (fileExtension !== 'pdf' || !detectedType || !validPdfMimeTypes.includes(detectedType.mime)) {
      await cleanupFiles(file.path);
      return {
        statusCode: 415,
        body: JSON.stringify({ error: 'Unsupported media type. Please upload a PDF file.' })
      };
    }
    
    // Generate job ID and paths
    const jobId = uuidv4();
    const s3InputKey = `${jobId}/input/${file.filename}`;
    const localInputPath = `${TMP_DIR}/${jobId}_input.pdf`;
    const outputPath = `${TMP_DIR}/${jobId}_removed.pdf`;
    const s3OutputKey = `${jobId}/output/${jobId}_removed.pdf`;
    
    // Upload input to S3 and download to local path
    await uploadToS3(file.path, s3InputKey, BUCKET_NAME);
    await downloadFromS3(s3InputKey, localInputPath, BUCKET_NAME);
    
    // Load the PDF document
    const pdfBytes = fs.readFileSync(localInputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    // Parse page ranges to determine which pages to remove
    try {
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
      
      // Update job progress
      const jobInfo = {
        jobId,
        status: 'completed',
        s3OutputKey,
        originalName: path.basename(file.originalname, '.pdf'),
        conversionType: 'remove-pdf-pages'
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
    } catch (pageRangeError) {
      console.error(`Error parsing page range: ${pageRangeError.message}`);
      await cleanupFiles(localInputPath, file.path);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: pageRangeError.message })
      };
    }
  } catch (error) {
    console.error(`Error: ${error}`);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to remove PDF pages.' })
    };
  }
}