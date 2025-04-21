/**
 * S3 helper functions for serverless converter
 */
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');

// Initialize S3 client with default credentials (IAM role)
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'mx-central-1' });

/**
 * Upload a file or buffer to S3
 * @param {string|Buffer} filePathOrBuffer - Local file path or Buffer
 * @param {string} key - S3 object key
 * @param {string} bucket - S3 bucket name
 * @returns {Promise<void>}
 */
async function uploadToS3(filePathOrBuffer, key, bucket) {
  const body = typeof filePathOrBuffer === 'string' ? fs.readFileSync(filePathOrBuffer) : filePathOrBuffer;
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
  });
  
  try {
    await s3Client.send(command);
    console.log(`S3 upload successful: ${key}`);
  } catch (err) {
    console.error(`S3 upload failed for ${key}: ${err}`);
    throw err;
  }
}

/**
 * Download a file from S3
 * @param {string} key - S3 object key
 * @param {string} localPath - Local file path
 * @param {string} bucket - S3 bucket name
 * @returns {Promise<void>}
 */
async function downloadFromS3(key, localPath, bucket) {
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
 * @param {object} options - Additional options (e.g., ResponseContentDisposition)
 * @returns {Promise<string>} - Pre-signed URL
 */
async function getSignedDownloadUrl(key, bucket, expiresIn = 3600, options = {}) {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...options
  });
  
  return await getSignedUrl(s3Client, command, { expiresIn });
}

module.exports = { uploadToS3, downloadFromS3, getSignedDownloadUrl };