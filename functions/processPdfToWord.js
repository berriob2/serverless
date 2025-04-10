/**
 * Process PDF to Word conversion in background
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';
import { updateJob } from '../lib/dynamodb.js';

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Process conversion of PDF to Word triggered by S3 event
 * @param {object} event - S3 event
 * @returns {Promise<object>} - Response
 */
export async function handler(event) {
  const record = event.Records[0];
  const bucket = record.s3.bucket.name;
  const s3InputKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const jobId = s3InputKey.split('/')[1].split('.')[0]; // e.g., pdf-to-word/<jobId>.pdf

  // Ensure tmp directory exists
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  const localInputPath = `${TMP_DIR}/${jobId}_input.pdf`;
  const outputPath = `${TMP_DIR}/${jobId}.docx`;
  const s3OutputKey = `output/${jobId}.docx`;

  try {
    // Update job status
    await updateJob(jobId, { status: 'processing', progress: 20 });

    // Download PDF from S3
    await downloadFromS3(s3InputKey, localInputPath, BUCKET_NAME);

    // Convert PDF to Word using Python script
    const sanitizedInputPath = path.normalize(localInputPath).replace(/\\+/g, '/').replace(/[\s&;$<>]/g, '');
    const sanitizedOutputPath = path.normalize(outputPath).replace(/\\+/g, '/').replace(/[\s&;$<>]/g, '');
    const pythonScriptPath = path.resolve(process.cwd(), 'pdf_to_word.py');
    const pythonProcess = spawn('python3', [pythonScriptPath, sanitizedInputPath, sanitizedOutputPath]);

    // Set timeout (4 minutes as per original)
    const processTimeout = setTimeout(() => {
      pythonProcess.kill();
      throw new Error('PDF to Word conversion timed out');
    }, 240000);

    // Process stdout and stderr
    let stderrData = '';

    pythonProcess.stdout.on('data', (data) => {
      console.log(`Job ${jobId} stdout: ${data}`);
    });

    pythonProcess.stderr.on('data', (data) => {
      const message = data.toString();
      stderrData += message;
      console.error(`Job ${jobId} stderr: ${message}`);

      // Parse progress (assuming script logs similar to original)
      const phaseMatch = message.match(/\[INFO\] \[(\d+)\/4\] (.*?)\.\.\./);
      const progressMatch = message.match(/\[INFO\] \((\d+)\/(\d+)\) Page \d+/);

      if (phaseMatch) {
        const phase = parseInt(phaseMatch[1], 10);
        const progress = 20 + (phase / 4) * 60; // Scale from 20% to 80%
        updateJob(jobId, { progress }).catch(err => console.error(`Progress update failed: ${err}`));
      } else if (progressMatch) {
        const currentPage = parseInt(progressMatch[1], 10);
        const totalPages = parseInt(progressMatch[2], 10);
        const pageProgress = (currentPage / totalPages) * 20 + 60; // Scale pages within 60-80%
        updateJob(jobId, { progress: pageProgress }).catch(err => console.error(`Page progress update failed: ${err}`));
      }
    });

    // Handle process completion
    await new Promise((resolve, reject) => {
      pythonProcess.on('close', async (code) => {
        clearTimeout(processTimeout);
        console.log(`Job ${jobId}: Python process exited with code ${code}`);

        if (code !== 0) {
          console.error(`Job ${jobId}: Conversion failed with code ${code}`);
          console.error(`stderr: ${stderrData}`);
          throw new Error(`Conversion failed with code ${code}`);
        }

        // Check if output file exists
        if (!fs.existsSync(outputPath)) {
          throw new Error('Output file was not created');
        }

        resolve();
      });

      pythonProcess.on('error', (error) => {
        clearTimeout(processTimeout);
        console.error(`Job ${jobId}: Python process error: ${error}`);
        reject(error);
      });
    });

    // Upload output to S3
    await updateJob(jobId, { status: 'uploading', progress: 95 });
    await uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);

    // Update job to completed
    await updateJob(jobId, {
      status: 'completed',
      progress: 100,
      s3OutputKey,
      originalName: path.basename(s3InputKey, '.pdf'),
      conversionType: 'pdf-to-word',
      completedAt: new Date().toISOString()
    });

    // Clean up local files
    await cleanupFiles(localInputPath, outputPath);

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
    await cleanupFiles(localInputPath, outputPath).catch(cleanupError => {
      console.error(`Cleanup failed: ${cleanupError}`);
    });

    throw error; // Let Lambda retry if needed
  }
}