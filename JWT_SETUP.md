# JWT Authentication Setup Guide

## Overview
This guide explains how to set up secure JWT authentication for the serverless-converter project using AWS SSM Parameter Store.

## Setting Up JWT Secret in AWS SSM Parameter Store

### 1. Create the Secret Parameter
Use the AWS CLI to create a secure parameter for your JWT secret:

```bash
# For development environment
aws ssm put-parameter \
  --name "/serverless-converter/dev/jwt-secret" \
  --value "your-strong-secret-key" \
  --type SecureString \
  --overwrite

# For production environment
aws ssm put-parameter \
  --name "/serverless-converter/prod/jwt-secret" \
  --value "your-production-secret-key" \
  --type SecureString \
  --overwrite
```

### 2. Alternative: Using Environment Variables
If you prefer to use environment variables directly (not recommended for production):

```bash
# Set in your .env file or deployment environment
JWT_SECRET=your-strong-secret-key
```

## Token Format Requirements

The JWT tokens used for authentication must include:

1. A `sub` or `userId` claim to identify the user
2. An `exp` (expiration) claim with a valid timestamp
3. Should be signed with the HS256 algorithm

## Example Token Generation (Node.js)

```javascript
const jwt = require('jsonwebtoken');

const token = jwt.sign(
  { 
    sub: 'user123',  // or userId: 'user123'
    role: 'user'     // optional additional claims
  }, 
  process.env.JWT_SECRET, 
  { 
    expiresIn: '1h',
    algorithm: 'HS256' 
  }
);
```

## Using Tokens in API Requests

Include the token in the Authorization header of your requests:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## Security Considerations

1. Use strong, unique secrets for each environment
2. Rotate secrets periodically
3. Set appropriate token expiration times
4. Use HTTPS for all API communications
5. Implement proper error handling without leaking sensitive information