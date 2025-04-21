/**
 * Process PDF to Word conversion in background
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

// Import helper functions
const s3Helpers = require('../lib/s3.js');
const { cleanupFiles } = require('../lib/cleanup.js');
const { updateJob } = require('../lib/dynamodb.js');

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

// Initialize clients
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'mx-central-1' });
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'mx-central-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Process conversion of PDF to Word triggered by S3 event
 * @param {object} event - S3 event
 * @returns {Promise<object>} - Response
 */
exports.handler = async function(event) {
  const record = event.Records[0];
  const bucket = record.s3.bucket.name;
  const s3InputKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const jobId = s3InputKey.split('/')[1].split('.')[0]; // e.g., pdf-to-word/<jobId>.pdf

  // Log environment details for debugging
  console.log('Environment PATH:', process.env.PATH);
  console.log('Checking python3.8 at /usr/local/bin/python3.8:', fs.existsSync('/usr/local/bin/python3.8'));

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
    await s3Helpers.downloadFromS3(s3InputKey, localInputPath, BUCKET_NAME);

    // Convert PDF to Word using Python script
    const sanitizedInputPath = path.normalize(localInputPath).replace(/\\+/g, '/').replace(/[\s&;$<>]/g, '');
    const sanitizedOutputPath = path.normalize(outputPath).replace(/\\+/g, '/').replace(/[\s&;$<>]/g, '');
    const pythonScriptPath = path.join(process.env.LAMBDA_TASK_ROOT, 'functions/pdf_to_word.py');

    // Verify Python script exists
    if (!fs.existsSync(pythonScriptPath)) {
      throw new Error(`Python script not found at ${pythonScriptPath}`);
    }

    console.log('Spawning python3.8 with args:', [
      pythonScriptPath,
      sanitizedInputPath,
      sanitizedOutputPath,
    ]);

    const pythonProcess = spawn('/usr/local/bin/python3.8', [
      pythonScriptPath,
      sanitizedInputPath,
      sanitizedOutputPath,
    ]);

    // Set timeout (4 minutes)
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
    });

    // Handle process completion
    await new Promise((resolve, reject) => {
      pythonProcess.on('close', async (code) => {
        clearTimeout(processTimeout);
        console.log(`Job ${jobId}: Python process exited with code ${code}`);

        try {
          if (code !== 0) {
            console.error(`Job ${jobId}: Conversion failed with code ${code}`);
            console.error(`stderr: ${stderrData}`);
            throw new Error(`Conversion failed with code ${code}`);
          }

          // Check if output file exists
          if (!fs.existsSync(outputPath)) {
            throw new Error('Output file was not created');
          }

          // Update progress after conversion
          await updateJob(jobId, { progress: 80 });
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      pythonProcess.on('error', (error) => {
        clearTimeout(processTimeout);
        console.error(`Job ${jobId}: Python process error: ${error}`);
        reject(error);
      });
    });

    // Upload output to S3
    await updateJob(jobId, { status: 'uploading', progress: 95 });
    await s3Helpers.uploadToS3(outputPath, s3OutputKey, BUCKET_NAME);

    // Update job to completed
    await updateJob(jobId, {
      status: 'completed',
      progress: 100,
      s3OutputKey,
      originalName: path.basename(s3InputKey, '.pdf'),
      conversionType: 'pdf-to-word',
      completedAt: new Date().toISOString(),
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
      progress: 0,
    }).catch(err => console.error(`Failed to update error status: ${err}`));

    // Clean up
    await cleanupFiles(localInputPath, outputPath).catch(cleanupError => {
      console.error(`Cleanup failed: ${cleanupError}`);
    });

    throw error; // Let Lambda retry if needed
  }
};