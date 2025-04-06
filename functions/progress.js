/**
 * Job progress tracking module
 */
import { updateJob as updateDynamoJob, getJob as getDynamoJob, listJobs, deleteJob } from '../lib/dynamodb.js'; // Static imports

/**
 * Create a new job or update an existing job
 * @param {string} jobId - Unique job identifier
 * @param {object} jobInfo - Job information
 * @returns {Promise<object>} - Updated job information
 */
export async function updateJob(jobId, jobInfo) {
  if (!jobId) throw new Error('Job ID is required');
  
  try {
    const updatedJob = await Promise.race([
      updateDynamoJob(jobId, jobInfo),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DynamoDB timeout')), 5000)) // 5s timeout
    ]);
    console.log(`Job ${jobId} updated in DynamoDB`);
    return updatedJob;
  } catch (error) {
    console.error(`Failed to update job ${jobId}:`, error);
    throw error;
  }
}

/**
 * Get job information
 * @param {string} jobId - Unique job identifier
 * @returns {Promise<object|null>} - Job information or null if not found
 */
export async function getJob(jobId) {
  if (!jobId) throw new Error('Job ID is required');
  
  try {
    const job = await Promise.race([
      getDynamoJob(jobId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DynamoDB timeout')), 5000)) // 5s timeout
    ]);
    if (!job) {
      console.warn(`Job ${jobId} not found`);
      return null;
    }
    return job;
  } catch (error) {
    console.error(`Failed to get job ${jobId}:`, error);
    throw error;
  }
}

/**
 * List all jobs (for administrative purposes)
 * @param {object} options - List options (e.g., limit, status filter)
 * @returns {Promise<Array<object>>} - Array of job information
 */
export async function listJobs(options = {}) {
  try {
    const jobs = await Promise.race([
      listJobs(options),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DynamoDB timeout')), 5000)) // 5s timeout
    ]);
    return jobs;
  } catch (error) {
    console.error('Failed to list jobs:', error);
    throw error;
  }
}

/**
 * Delete a job
 * @param {string} jobId - Unique job identifier
 * @returns {Promise<boolean>} - True if job was deleted, false if not found
 */
export async function deleteJob(jobId) {
  if (!jobId) throw new Error('Job ID is required');
  
  try {
    const deleted = await Promise.race([
      deleteJob(jobId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DynamoDB timeout')), 5000)) // 5s timeout
    ]);
    return deleted;
  } catch (error) {
    console.error(`Failed to delete job ${jobId}:`, error);
    throw error;
  }
}

/**
 * HTTP handler for job progress API
 * @param {object} event - HTTP event
 * @param {object} context - Lambda context
 * @returns {Promise<object>} - Response
 */
export async function handler(event, context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*', // CORS header for browser access
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