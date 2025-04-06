/**
 * S3 helper functions for serverless converter
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';

// Initialize S3 client
let s3Client;

/**
 * Initialize the S3 client with credentials
 * @param {object} config - S3 configuration
 */
export function initS3Client(config) {
  s3Client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * Upload a file to S3
 * @param {string} filePath - Local file path
 * @param {string} key - S3 object key
 * @param {string} bucket - S3 bucket name
 * @returns {Promise<string>} - S3 URI
 */
export async function uploadToS3(filePath, key, bucket) {
  if (!s3Client) throw new Error('S3 client not initialized');
  
  const fileContent = fs.readFileSync(filePath);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileContent,
  });
  
  try {
    await s3Client.send(command);
    console.log(`S3 upload successful: ${key}`);
  } catch (err) {
    console.error(`S3 upload failed for ${key}: ${err}`);
    throw err;
  }
  
  return `s3://${bucket}/${key}`;
}

/**
 * Download a file from S3
 * @param {string} key - S3 object key
 * @param {string} localPath - Local file path
 * @param {string} bucket - S3 bucket name
 * @returns {Promise<void>}
 */
export async function downloadFromS3(key, localPath, bucket) {
  if (!s3Client) throw new Error('S3 client not initialized');
  
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  
  const response = await s3Client.send(command);
  fs.writeFileSync(localPath, Buffer.from(await response.Body.transformToByteArray()));
}

/**
 * Generate a pre-signed URL for downloading a file from S3
 * @param {string} key - S3 object key
 * @param {string} bucket - S3 bucket name
 * @param {number} expiresIn - Expiration time in seconds
 * @returns {Promise<string>} - Pre-signed URL
 */
export async function getSignedDownloadUrl(key, bucket, expiresIn = 300) {
  if (!s3Client) throw new Error('S3 client not initialized');
  
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  
  return await getSignedUrl(s3Client, command, { expiresIn });
}