/**
 * API Gateway Custom Authorizer
 * 
 * This function validates JWT tokens for API Gateway endpoints.
 * It implements a token-based authorization mechanism to secure API endpoints.
 * Enhanced with AWS SSM Parameter Store for secret management and structured logging.
 */
import jwt from 'jsonwebtoken';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Initialize SSM client
const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'mx-central-1' });

// Cache for JWT secret to optimize cold starts
let JWT_SECRET;

/**
 * Retrieves the JWT secret from SSM Parameter Store
 * @returns {Promise<string>} - The JWT secret
 */
async function getSecret() {
  try {
    // If JWT_SECRET is provided as a direct environment variable, use it
    if (process.env.JWT_SECRET && !process.env.JWT_SECRET.startsWith('/')) {
      return process.env.JWT_SECRET;
    }
    
    // Otherwise, treat it as an SSM parameter path
    const paramName = process.env.JWT_SECRET || `/serverless-converter/${process.env.STAGE || 'dev'}/jwt-secret`;
    
    const command = new GetParameterCommand({
      Name: paramName,
      WithDecryption: true
    });
    
    const { Parameter } = await ssmClient.send(command);
    return Parameter.Value;
  } catch (error) {
    log('Error retrieving secret from SSM', { error: error.message });
    // Fallback to default only in development
    if (process.env.STAGE === 'dev') {
      log('Using fallback secret in development mode', {});
      return 'change-this-secret-in-production';
    }
    throw error;
  }
}

/**
 * Structured logging helper
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
function log(message, data = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    service: 'apiAuthorizer',
    message,
    ...data
  }));
}

/**
 * Validates the Authorization token and generates an IAM policy
 * @param {object} event - API Gateway event
 * @param {object} context - Lambda context
 * @returns {Promise<object>} - IAM policy document
 */
export async function handler(event, context) {
  log('Auth event received', { methodArn: event.methodArn });
  
  try {
    // Initialize JWT secret if not already cached
    if (!JWT_SECRET) {
      JWT_SECRET = await getSecret();
    }
    
    // Get the Authorization token from the request header
    const authorizationToken = event.authorizationToken;
    
    if (!authorizationToken) {
      throw new Error('Unauthorized: No token provided');
    }
    
    // Remove 'Bearer ' prefix if present
    const token = authorizationToken.replace(/^Bearer\s+/, '');
    
    if (!token) {
      throw new Error('Unauthorized: Empty token');
    }
    
    // Verify the JWT token with explicit algorithm specification
    const decodedToken = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    
    // Explicit expiration check
    if (!decodedToken.exp || Date.now() >= decodedToken.exp * 1000) {
      throw new Error('Token expired');
    }
    
    // Extract user information from the token
    const userId = decodedToken.sub || decodedToken.userId;
    
    if (!userId) {
      throw new Error('Invalid token: Missing user identifier');
    }
    
    log('Token validated successfully', { userId });
    
    // Generate IAM policy
    return generatePolicy(userId, 'Allow', event.methodArn);
  } catch (error) {
    log('Authorization error', { error: error.message, stack: error.stack });
    
    // For security, don't expose detailed error messages
    return generatePolicy('user', 'Deny', event.methodArn);
  }
}

/**
 * Generates an IAM policy document
 * @param {string} principalId - User identifier
 * @param {string} effect - Allow or Deny
 * @param {string} resource - API Gateway resource ARN
 * @returns {object} - Policy document
 */
function generatePolicy(principalId, effect, resource) {
  const authResponse = {
    principalId
  };
  
  if (effect && resource) {
    const policyDocument = {
      Version: '2012-10-17',
      Statement: [{
        Action: 'execute-api:Invoke',
        Effect: effect,
        Resource: resource
      }]
    };
    
    authResponse.policyDocument = policyDocument;
  }
  
  // Optional context information that can be used in the API
  authResponse.context = {
    userId: principalId,
    // Add additional context as needed
    timestamp: new Date().toISOString()
  };
  
  return authResponse;
}