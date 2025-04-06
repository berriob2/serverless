/**
 * API Gateway Custom Authorizer
 * 
 * This function validates JWT tokens for API Gateway endpoints.
 * It implements a token-based authorization mechanism to secure API endpoints.
 */
import jwt from 'jsonwebtoken';

// Secret key for JWT verification - in production, store this in AWS Secrets Manager
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

/**
 * Validates the Authorization token and generates an IAM policy
 * @param {object} event - API Gateway event
 * @param {object} context - Lambda context
 * @returns {Promise<object>} - IAM policy document
 */
export async function handler(event, context) {
  console.log('Auth event:', JSON.stringify(event, null, 2));
  
  try {
    // Get the Authorization token from the request header
    const authorizationToken = event.authorizationToken;
    
    if (!authorizationToken) {
      throw new Error('Unauthorized: No token provided');
    }
    
    // Remove 'Bearer ' prefix if present
    const token = authorizationToken.replace(/^Bearer\s+/, '');
    
    // Verify the JWT token
    const decodedToken = jwt.verify(token, JWT_SECRET);
    
    // Extract user information from the token
    const userId = decodedToken.sub || decodedToken.userId;
    
    if (!userId) {
      throw new Error('Invalid token: Missing user identifier');
    }
    
    // Generate IAM policy
    return generatePolicy(userId, 'Allow', event.methodArn);
  } catch (error) {
    console.error('Authorization error:', error);
    
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