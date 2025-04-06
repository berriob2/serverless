/**
 * DynamoDB helper functions for job tracking
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  GetCommand, 
  PutCommand, 
  UpdateCommand, 
  DeleteCommand,
  QueryCommand 
} from '@aws-sdk/lib-dynamodb';

// Initialize DynamoDB client
let dynamoClient;
let docClient;

/**
 * Initialize the DynamoDB client
 * @param {object} config - DynamoDB configuration
 */
export function initDynamoClient(config = {}) {
  dynamoClient = new DynamoDBClient({
    region: process.env.AWS_REGION || 'us-east-1',
    ...config
  });
  
  docClient = DynamoDBDocumentClient.from(dynamoClient);
}

// Get the DynamoDB client, initializing if necessary
function getDocClient() {
  if (!docClient) {
    initDynamoClient();
  }
  return docClient;
}

/**
 * Create or update a job in DynamoDB
 * @param {string} jobId - Unique job identifier
 * @param {object} jobInfo - Job information
 * @returns {Promise<object>} - Updated job information
 */
export async function updateJob(jobId, jobInfo) {
  if (!jobId) {
    throw new Error('Job ID is required');
  }
  
  const client = getDocClient();
  const tableName = process.env.JOBS_TABLE_NAME;
  
  // Set timestamps
  const now = new Date().toISOString();
  const updatedJob = { 
    ...jobInfo, 
    updatedAt: now,
    jobId // Ensure jobId is included
  };
  
  // If this is a new job, set createdAt
  if (!jobInfo.createdAt) {
    updatedJob.createdAt = now;
  }
  
  // Set TTL if not already set (default to 7 days)
  if (!updatedJob.expiresAt) {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 7); // 7 days from now
    updatedJob.expiresAt = Math.floor(expiryDate.getTime() / 1000); // Unix timestamp
  }
  
  // Store the job in DynamoDB
  const command = new PutCommand({
    TableName: tableName,
    Item: updatedJob
  });
  
  try {
    await client.send(command);
    console.log(`Job ${jobId} updated in DynamoDB`);
    return updatedJob;
  } catch (error) {
    console.error(`Failed to update job ${jobId} in DynamoDB:`, error);
    throw error;
  }
}

/**
 * Get job information from DynamoDB
 * @param {string} jobId - Unique job identifier
 * @returns {Promise<object|null>} - Job information or null if not found
 */
export async function getJob(jobId) {
  if (!jobId) {
    throw new Error('Job ID is required');
  }
  
  const client = getDocClient();
  const tableName = process.env.JOBS_TABLE_NAME;
  
  const command = new GetCommand({
    TableName: tableName,
    Key: { jobId }
  });
  
  try {
    const response = await client.send(command);
    if (!response.Item) {
      console.warn(`Job ${jobId} not found in DynamoDB`);
      return null;
    }
    
    return response.Item;
  } catch (error) {
    console.error(`Failed to get job ${jobId} from DynamoDB:`, error);
    throw error;
  }
}

/**
 * List jobs from DynamoDB
 * @param {object} options - List options (e.g., limit, status filter)
 * @returns {Promise<Array<object>>} - Array of job information
 */
export async function listJobs(options = {}) {
  const { limit = 100, status } = options;
  const client = getDocClient();
  const tableName = process.env.JOBS_TABLE_NAME;
  
  // If status is provided, use a query with a GSI
  // Note: This requires setting up a GSI on the status attribute
  if (status) {
    const command = new QueryCommand({
      TableName: tableName,
      IndexName: 'StatusIndex', // This GSI would need to be created
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': status
      },
      Limit: limit,
      ScanIndexForward: false // Sort by most recent first (if using a sort key)
    });
    
    try {
      const response = await client.send(command);
      return response.Items || [];
    } catch (error) {
      console.error(`Failed to query jobs by status from DynamoDB:`, error);
      throw error;
    }
  }
  
  // Otherwise, scan the table (less efficient for large tables)
  // In a production environment, consider using a more efficient approach
  const command = new QueryCommand({
    TableName: tableName,
    Limit: limit,
    ScanIndexForward: false // Sort by most recent first (if using a sort key)
  });
  
  try {
    const response = await client.send(command);
    return response.Items || [];
  } catch (error) {
    console.error(`Failed to list jobs from DynamoDB:`, error);
    throw error;
  }
}

/**
 * Delete a job from DynamoDB
 * @param {string} jobId - Unique job identifier
 * @returns {Promise<boolean>} - True if job was deleted, false if not found
 */
export async function deleteJob(jobId) {
  if (!jobId) {
    throw new Error('Job ID is required');
  }
  
  const client = getDocClient();
  const tableName = process.env.JOBS_TABLE_NAME;
  
  const command = new DeleteCommand({
    TableName: tableName,
    Key: { jobId },
    ReturnValues: 'ALL_OLD'
  });
  
  try {
    const response = await client.send(command);
    const deleted = !!response.Attributes;
    
    if (deleted) {
      console.log(`Job ${jobId} deleted from DynamoDB`);
    } else {
      console.warn(`Job ${jobId} not found for deletion in DynamoDB`);
    }
    
    return deleted;
  } catch (error) {
    console.error(`Failed to delete job ${jobId} from DynamoDB:`, error);
    throw error;
  }
}