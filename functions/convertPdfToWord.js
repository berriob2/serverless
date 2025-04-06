/**
 * Convert PDF to Word function
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileTypeFromFile } from 'file-type';
import { spawn } from 'child_process';

import { uploadToS3, downloadFromS3 } from '../lib/s3.js';
import { cleanupFiles } from '../lib/cleanup.js';

// Configuration
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

/**
 * Convert PDF to Word
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
    const { file } = event;
    
    if (!file) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No file uploaded.' })
      };
    }
    
    // Enhanced file validation
    const fileExtension = path.extname(file.originalname).slice(1).toLowerCase();
    const detectedType = await fileTypeFromFile(file.path);
    const validPdfMimeTypes = ['application/pdf'];
    
    // Check file extension and MIME type
    if (fileExtension !== 'pdf' || !detectedType || !validPdfMimeTypes.includes(detectedType.mime)) {
      await cleanupFiles(file.path);
      return {
        statusCode: 415,
        body: JSON.stringify({ error: 'Unsupported media type. Please upload a PDF file.' })
      };
    }
    
    // Check file size (limit to 10MB)
    const stats = fs.statSync(file.path);
    const fileSizeInBytes = stats.size;
    const fileSizeInMB = fileSizeInBytes / (1024 * 1024);
    if (fileSizeInMB > 10) {
      await cleanupFiles(file.path);
      return {
        statusCode: 413,
        body: JSON.stringify({ error: 'File too large. Maximum file size is 10MB.' })
      };
    }
    
    // Additional security check - validate PDF header
    const fileBuffer = fs.readFileSync(file.path, { encoding: null, flag: 'r' });
    const isPdfHeader = fileBuffer.slice(0, 5).toString() === '%PDF-';
    if (!isPdfHeader) {
      await cleanupFiles(file.path);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid PDF file format.' })
      };
    }
    
    // Generate job ID and paths
    const jobId = uuidv4();
    const s3InputKey = `${jobId}/input/${file.filename}`;
    const localInputPath = `${TMP_DIR}/${jobId}_input.pdf`;
    const outputPath = `${TMP_DIR}/${jobId}.docx`;
    const s3OutputKey = `${jobId}/output/${jobId}.docx`;
    
    // Upload input to S3 and download to local path
    await uploadToS3(file.path, s3InputKey, BUCKET_NAME);
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
      }
      
      if (progressMatch) {
        const currentPage = parseInt(progressMatch[1], 10);
        const totalPages = parseInt(progressMatch[2], 10);
        console.log(`Progress: ${currentPage}/${totalPages} pages`);
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
          resolve({
            statusCode: 500,
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
          
          // Update job progress
          const jobInfo = {
            jobId,
            status: 'completed',
            s3OutputKey,
            originalName: path.basename(file.originalname, '.pdf'),
            conversionType: 'pdf-to-word'
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
          
          resolve({
            statusCode: 200,
            body: JSON.stringify({ jobId })
          });
        } catch (error) {
          console.error(`Error in PDF to Word conversion: ${error}`);
          await cleanupFiles(localInputPath, outputPath, file.path);
          resolve({
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to convert PDF to Word.' })
          });
        }
      });
      
      // Handle process error
      pythonProcess.on('error', async (error) => {
        console.error(`PDF to Word process error: ${error}`);
        await cleanupFiles(localInputPath, file.path);
        reject(error);
      });
    });
  } catch (error) {
    console.error(`Error: ${error}`);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to convert PDF to Word.' })
    };
  }
}