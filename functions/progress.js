/**
 * Job progress tracking module
 * 
 * This module provides functions to track and retrieve job progress information.
 * In a production environment, this would typically use a database like DynamoDB
 * or MongoDB for persistence. For simplicity, this implementation uses in-memory
 * storage, which means job information is lost when the Lambda function is recycled.
 */

// In-memory job storage
// Note: In a serverless environment, this will be reset when the Lambda container is recycled
const jobStore = new Map();

/**
 * Create a new job or update an existing job
 * @param {string} jobId - Unique job identifier
 * @param {object} jobInfo - Job information
 * @returns {object} - Updated job information
 */
export function updateJob(jobId, jobInfo) {
  if (!jobId) {
    throw new Error('Job ID is required');
  }
  
  // Merge with existing job info if it exists
  const existingJob = jobStore.get(jobId) || {};
  const updatedJob = { ...existingJob, ...jobInfo, updatedAt: new Date().toISOString() };
  
  // If this is a new job, set createdAt
  if (!existingJob.createdAt) {
    updatedJob.createdAt = updatedJob.updatedAt;
  }
  
  // Store the updated job
  jobStore.set(jobId, updatedJob);
  
  console.log(`Job ${jobId} updated: ${JSON.stringify(updatedJob)}`);
  return updatedJob;
}

/**
 * Get job information
 * @param {string} jobId - Unique job identifier
 * @returns {object|null} - Job information or null if not found
 */
export function getJob(jobId) {
  if (!jobId) {
    throw new Error('Job ID is required');
  }
  
  const job = jobStore.get(jobId);
  if (!job) {
    console.warn(`Job ${jobId} not found`);
    return null;
  }
  
  return job;
}

/**
 * List all jobs (for administrative purposes)
 * @param {object} options - List options (e.g., limit, status filter)
 * @returns {Array<object>} - Array of job information
 */
export function listJobs(options = {}) {
  const { limit = 100, status } = options;
  
  let jobs = Array.from(jobStore.values());
  
  // Apply status filter if provided
  if (status) {
    jobs = jobs.filter(job => job.status === status);
  }
  
  // Sort by updatedAt (newest first)
  jobs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  
  // Apply limit
  return jobs.slice(0, limit);
}

/**
 * Delete a job
 * @param {string} jobId - Unique job identifier
 * @returns {boolean} - True if job was deleted, false if not found
 */
export function deleteJob(jobId) {
  if (!jobId) {
    throw new Error('Job ID is required');
  }
  
  const deleted = jobStore.delete(jobId);
  if (deleted) {
    console.log(`Job ${jobId} deleted`);
  } else {
    console.warn(`Job ${jobId} not found for deletion`);
  }
  
  return deleted;
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
    
    const job = getJob(jobId);
    
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