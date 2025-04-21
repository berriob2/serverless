/**
 * API Authorizer function for JWT-based authentication
 * 
 * Validates JWT tokens from the Authorization header and generates an IAM policy
 * for API Gateway to allow or deny access to protected endpoints.
 */
const jwt = require('jsonwebtoken');

// Configuration
const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Generate an IAM policy document
 * @param {string} principalId - Identifier for the authenticated user
 * @param {string} effect - Allow or Deny
 * @param {string} resource - API Gateway resource ARN
 * @returns {object} - IAM policy document
 */
function generatePolicy(principalId, effect, resource) {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: resource
        }
      ]
    }
  };
}

/**
 * Authorizer handler
 * @param {object} event - API Gateway authorizer event
 * @param {object} context - Lambda context
 * @returns {Promise<object>} - IAM policy or throws error
 */
export const handler = async (event, context) => {
  console.log('Authorizer event:', JSON.stringify(event, null, 2));

  try {
    // Check for JWT_SECRET
    if (!JWT_SECRET) {
      console.error('JWT_SECRET environment variable not set');
      throw new Error('Server configuration error');
    }

    // Extract token from Authorization header
    const authHeader = event.headers?.Authorization || event.authorizationToken;
    if (!authHeader) {
      console.error('No Authorization header provided');
      throw new Error('No token provided');
    }

    const token = authHeader.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : authHeader;
    
    if (!token) {
      console.error('Invalid Authorization header format');
      throw new Error('Invalid token format');
    }

    // Verify JWT
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('Token decoded:', decoded);

    // Generate Allow policy
    // principalId can be user ID from token (e.g., decoded.sub) or a generic identifier
    const principalId = decoded.sub || 'user';
    return generatePolicy(principalId, 'Allow', event.methodArn);
  } catch (error) {
    console.error('Authorization failed:', error.message);

    // For unauthorized access, throw an error to trigger a 401 response
    if (error.name === 'JsonWebTokenError' || error.message === 'No token provided' || error.message === 'Invalid token format') {
      throw new Error('Unauthorized');
    }

    // For other errors (e.g., server misconfiguration), throw a generic error for 500
    throw new Error('Authorization processing failed');
  }
};