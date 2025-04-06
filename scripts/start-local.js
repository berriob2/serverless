/**
 * Start local development server
 * 
 * This script starts the serverless-offline server for local development and testing.
 */
import { spawn } from 'child_process';
import { config } from 'dotenv';

// Load environment variables from .env file
config();

console.log('Starting serverless-offline server...');

// Start serverless-offline server
const serverless = spawn('npx', [
  'serverless', 
  'offline', 
  'start',
  '--config', 
  'serverless-offline.yml'
], {
  stdio: 'inherit',
  shell: true
});

// Handle process events
serverless.on('error', (error) => {
  console.error(`Failed to start serverless-offline: ${error.message}`);
  process.exit(1);
});

serverless.on('close', (code) => {
  console.log(`serverless-offline exited with code ${code}`);
  process.exit(code);
});

// Handle termination signals
process.on('SIGINT', () => {
  console.log('Stopping serverless-offline server...');
  serverless.kill('SIGINT');
});

process.on('SIGTERM', () => {
  console.log('Stopping serverless-offline server...');
  serverless.kill('SIGTERM');
});