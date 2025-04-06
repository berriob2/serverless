/**
 * Initialize local development environment
 * 
 * This script loads environment variables from .env file and initializes
 * the S3 client for local development and testing.
 */
import { config } from 'dotenv';
import { initS3Client } from '../lib/s3.js';
import fs from 'fs';
import path from 'path';

// Load environment variables from .env file
config();

// Create tmp directory if it doesn't exist
const tmpDir = process.env.TMP_DIR || '/tmp';
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
  console.log(`Created temporary directory: ${tmpDir}`);
}

// Initialize S3 client with credentials from environment variables
initS3Client({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

console.log('S3 client initialized with environment variables');
console.log(`AWS_REGION: ${process.env.AWS_REGION}`);
console.log(`AWS_BUCKET_NAME: ${process.env.AWS_BUCKET_NAME}`);
console.log(`TMP_DIR: ${process.env.TMP_DIR}`);

console.log('Local development environment initialized successfully');