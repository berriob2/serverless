/**
 * Convert PDF to Word function
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileTypeFromFile } from 'file-type';
import { spawn } from 'child_process';
import { parse } from 'lambda-multipart-parser'; // Added for multipart parsing

import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { updateJob } from '../lib/dynamodb.js'; // Added for consistent job tracking

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Convert PDF to Word
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

    if (!files || files.length === 0) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No file uploaded.' })
      };
    }

    // Use the first file from the upload
    const file = files[0];

    // Validate file size (10 MB limit as per original)
    if (file.size > 10 * 1024 * 1024) {
      await cleanupFiles(file.path);
      return {
        statusCode: 413,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'File too large. Maximum file size is 10MB.' })
      };
    }

    // Enhanced file validation
    const fileExtension = path.extname(file.filename).slice(1).toLowerCase();
    const detectedType = await fileTypeFromFile(file.path);
    const validPdfMimeTypes = ['application/pdf'];

    // Check file extension and MIME type
    if (fileExtension !== 'pdf' || !detectedType || !validPdfMimeTypes.includes(detectedType.mime)) {
      await cleanupFiles(file.path);
      return {
        statusCode: 415,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unsupported media type. Please upload a PDF file.' })
      };
    }

    // Additional security check - validate PDF header
    const fileBuffer = fs.readFileSync(file.path, { encoding: null, flag: 'r' });
    const isPdfHeader = fileBuffer.slice(0, 5).toString() === '%PDF-';
    if (!isPdfHeader) {
      await cleanupFiles(file.path);
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid PDF file format.' })
      };
    }

    // Generate job ID and paths
    const jobId = uuidv4();
    const s3InputKey = `${jobId}/input/${file.filename}`;
    const localInputPath = `${TMP_DIR}/${jobId}_input.pdf`;
    const outputPath = `${TMP_DIR}/${jobId}.docx`;
    const s3OutputKey = `${jobId}/output/${jobId}.docx`;

    // Initialize job in DynamoDB
    await updateJob(jobId, {
      status: 'uploading',
      progress: 0,
      inputFile: file.filename,
      conversionType: 'pdf-to-word'
    });

    // Upload input to S3 and download to local path
    await uploadToS3(file.path, s3InputKey, BUCKET_NAME);
    await updateJob(jobId, { status: 'processing', progress: 20 });
    await downloadFromS3(s3InputKey, localInputPath, BUCKET_NAME);

    // Convert PDF to Word using python script
    // Sanitize file paths to prevent command injection
    const sanitizedInputPath = path.normalize(localInputPath).replace(/\\+/g, '/').replace(/[\s&;$<>]/g, '');
    const sanitizedOutputPath = path.normalize(outputPath).replace(/\\+/g, '/').replace(/[\s&;$<>]/g, '');

    // Use absolute path to the Python script for security
    const pythonScriptPath = path.resolve(process.cwd(), 'pdf_to_word.py');
    const pythonProcess = spawn('python3', [pythonScriptPath, sanitizedInputPath, sanitizedOutputPath]);

    // Set timeout to prevent long-running processes
    const processTimeout = setTimeout(() => {
      pythonProcess.kill();
      throw new Error('PDF to Word conversion timed out');
    }, 240000); // 4 minute timeout

    // Process stdout and stderr
    let stdoutData = '';
    let stderrData = '';

    pythonProcess.stdout.on('data', (data) => {
      stdoutData += data.toString();
      console.log(`PDF to Word stdout: ${data}`);
    });

    pythonProcess.stderr.on('data', (data) => {
      const message = data.toString();
      stderrData += message;
      console.error(`PDF to Word stderr: ${message}`);

      // Parse progress information
      const phaseMatch = message.match(/\[INFO\] \[(\d+)\/4\] (.*?)\.\.\./);
      const progressMatch = message.match(/\[INFO\] \((\d+)\/(\d+)\) Page \d+/);

      if (phaseMatch) {
        const phase = parseInt(phaseMatch[1], 10);
        console.log(`Phase ${phase}/4: ${phaseMatch[2]}`);
        const progress = 20 + (phase / 4) * 60; // Scale from 20% to 80%
        updateJob(jobId, { progress }).catch(err => console.error(`Progress update failed: ${err}`));
      }

      if (progressMatch) {
        const currentPage = parseInt(progressMatch[1], 10);
        const totalPages = parseInt(progressMatch[2], 10);
        const pageProgress = (currentPage / totalPages) * 20 + 60; // Scale pages within 60-80%
        console.log(`Progress: ${currentPage}/${totalPages} pages`);
        updateJob(jobId, { progress: pageProgress }).catch(err => console.error(`Page progress update failed: ${err}`));
      }
    });

    // Handle process completion
    return new Promise((resolve, reject) => {
      pythonProcess.on('close', async (code) => {
        // Clear the timeout to prevent memory leaks
        clearTimeout(processTimeout);
        console.log(`PDF to Word process exited with code ${code}`);

        if (code !== 0) {
          console.error(`PDF to Word conversion failed with code ${code}`);
          console.error(`stderr: ${stderrData}`);
          await cleanupFiles(localInputPath, file.path);
          await updateJob(jobId, { status: 'failed', error: `Conversion failed with code ${code}`, progress: 0 });
          resolve({
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'PDF to Word conversion failed.' })
          });
          return;
        }

        try {
          // Check if output file exists
          if (!fs.existsSync(outputPath)) {
            throw new Error('Output file was not created');
          }

          // Upload output to S3
          await uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);

          // Update job progress to completed
          await updateJob(jobId, {
            jobId,
            status: 'completed',
            progress: 100,
            s3OutputKey,
            originalName: path.basename(file.filename, '.pdf'),
            conversionType: 'pdf-to-word',
            completedAt: new Date().toISOString()
          });

          // Clean up local files
          await cleanupFiles(localInputPath, outputPath, file.path);

          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId })
          });
        } catch (error) {
          console.error(`Error in PDF to Word conversion: ${error}`);
          await updateJob(jobId, { status: 'failed', error: error.message, progress: 0 });
          await cleanupFiles(localInputPath, outputPath, file.path);
          resolve({
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Failed to convert PDF to Word.' })
          });
        }
      });

      // Handle process error
      pythonProcess.on('error', async (error) => {
        console.error(`PDF to Word process error: ${error}`);
        await updateJob(jobId, { status: 'failed', error: error.message, progress: 0 });
        await cleanupFiles(localInputPath, file.path);
        reject(error);
      });
    });
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
        error: 'Failed to convert PDF to Word.',
        requestId: context.awsRequestId
      })
    };
  }
}