/**
 * HTTP handler for job progress API
 */
import { getJob } from '../lib/dynamodb.js';

export async function handler(event, context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  };

  try {
    const jobId = event.pathParameters?.jobId;
    
    if (!jobId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Job ID is required' })
      };
    }
    
    const job = await getJob(jobId);
    
    if (!job) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Job not found' })
      };
    }
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(job)
    };
  } catch (error) {
    console.error('Progress API error:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to retrieve job progress',
        message: error.message,
        requestId: context.awsRequestId
      })
    };
  }
}