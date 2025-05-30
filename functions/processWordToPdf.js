/**
 * Process Word to PDF conversion in background
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { S3Client } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

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
 * Process conversion of Word to PDF triggered by S3 event
 * @param {object} event - S3 event
 * @returns {Promise<object>} - Response
 */
exports.handler = async function (event) {
  const record = event.Records[0];
  const bucket = record.s3.bucket.name;
  const s3InputKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const jobId = s3InputKey.split('/')[1].split('.')[0]; // e.g., word-to-pdf/<jobId>.docx

  const localInputPath = `${TMP_DIR}/${jobId}_input.docx`;
  const outputPath = `${TMP_DIR}/${jobId}.pdf`;
  const s3OutputKey = `output/${jobId}.pdf`;

  try {
    // Update job status
    await updateJob(jobId, { status: 'processing', progress: 20 });

    // Download Word document from S3
    await s3Helpers.downloadFromS3(s3InputKey, localInputPath, BUCKET_NAME);

    // Convert Word to PDF using Python script with LibreOffice
    const sanitizedInputPath = path.normalize(localInputPath).replace(/\\+/g, '/').replace(/[\s&;$<>]/g, '');
    const sanitizedOutputPath = path.normalize(outputPath).replace(/\\+/g, '/').replace(/[\s&;$<>]/g, '');
    const pythonScriptPath = path.join(process.env.LAMBDA_TASK_ROOT, 'functions/word_to_pdf.py');

    if (!fs.existsSync(pythonScriptPath)) {
      throw new Error(`Python script not found at ${pythonScriptPath}`);
    }

    const pythonProcess = spawn('/usr/local/bin/python3.8', [
      pythonScriptPath,
      sanitizedInputPath,
      sanitizedOutputPath,
    ]);

    // Set timeout (4 minutes)
    const processTimeout = setTimeout(() => {
      pythonProcess.kill();
      throw new Error('Word to PDF conversion timed out');
    }, 240000);

    let stderrData = '';

    pythonProcess.stdout.on('data', (data) => {
      console.log(`Job ${jobId} stdout: ${data}`);
    });

    pythonProcess.stderr.on('data', (data) => {
      const message = data.toString();
      stderrData += message;
      console.error(`Job ${jobId} stderr: ${message}`);
    });

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

          if (!fs.existsSync(outputPath)) {
            throw new Error('Output file was not created');
          }

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
      originalName: path.basename(s3InputKey, '.docx'),
      conversionType: 'word-to-pdf',
      completedAt: new Date().toISOString(),
    });

    // Clean up local files
    await cleanupFiles(localInputPath, outputPath);

    return { statusCode: 200, body: 'Conversion completed' };
  } catch (error) {
    console.error(`Error processing job ${jobId}: ${error.message}`);

    await updateJob(jobId, {
      status: 'failed',
      error: error.message,
      progress: 0,
    }).catch((err) => console.error(`Failed to update error status: ${err}`));

    await cleanupFiles(localInputPath, outputPath).catch((cleanupError) => {
      console.error(`Cleanup failed: ${cleanupError}`);
    });

    throw error;
  }
};