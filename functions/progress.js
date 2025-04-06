/**
 * Job progress tracking module
 * 
 * This module provides functions to track and retrieve job progress information.
 * Uses DynamoDB for persistence to ensure job information is maintained across
 * Lambda function invocations.
 */
import { updateJob as updateDynamoJob, getJob as getDynamoJob } from '../lib/dynamodb.js';

/**
 * Create a new job or update an existing job
 * @param {string} jobId - Unique job identifier
 * @param {object} jobInfo - Job information
 * @returns {Promise<object>} - Updated job information
 */
export async function updateJob(jobId, jobInfo) {
  if (!jobId) {
    throw new Error('Job ID is required');
  }
  
  try {
    const updatedJob = await updateDynamoJob(jobId, jobInfo);
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
  if (!jobId) {
    throw new Error('Job ID is required');
  }
  
  try {
    const job = await getDynamoJob(jobId);
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
    const jobs = await import('../lib/dynamodb.js').then(module => module.listJobs(options));
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
  if (!jobId) {
    throw new Error('Job ID is required');
  }
  
  try {
    const deleted = await import('../lib/dynamodb.js').then(module => module.deleteJob(jobId));
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
  try {
    const jobId = event.pathParameters?.jobId;
    
    if (!jobId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Job ID is required' })
      };
    }
    
    const job = await getJob(jobId);
    
    if (!job) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Job not found' })
      };
    }
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // CORS header for browser access
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify(job)
    };
  } catch (error) {
    console.error('Progress API error:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to retrieve job progress',
        message: error.message
      })
    };
  }
}