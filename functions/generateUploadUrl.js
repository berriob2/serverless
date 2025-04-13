const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const s3 = new AWS.S3();
const dynamodb = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  const { path } = event.requestContext.http; // e.g., /convert/video or /convert/video-to-mp3
  const jobId = uuidv4();
  const bucket = process.env.AWS_BUCKET_NAME; // serverless-converter-dev-uploads
  const prefix = path.includes('video-to-mp3') ? 'video-to-mp3' : 'videos';
  const key = `${prefix}/${jobId}.mp4`; // Adjust extension based on your needs

  // Store job metadata in DynamoDB
  const params = {
    TableName: process.env.JOBS_TABLE_NAME, // serverless-converter-dev-jobs
    Item: {
      jobId,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // TTL: 7 days
      inputKey: key,
      outputKey: `converted/${jobId}${path.includes('video-to-mp3') ? '.mp3' : '.mp4'}`, // Adjust output extension
    },
  };
  await dynamodb.put(params).promise();

  // Generate pre-signed S3 URL
  const uploadUrl = await s3.getSignedUrlPromise('putObject', {
    Bucket: bucket,
    Key: key,
    Expires: 300, // URL expires in 5 minutes
    ContentType: 'video/mp4', // Adjust based on allowed video types
  });

  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*', // Adjust for production
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
    body: JSON.stringify({
      jobId,
      uploadUrl,
    }),
  };
};