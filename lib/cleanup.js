/**
 * Cleanup utilities for serverless converter
 */
import fs from 'fs';
import { rimraf } from 'rimraf';

/**
 * Clean up temporary files
 * @param {...string} paths - Paths to clean up
 * @returns {Promise<void>}
 */
export async function cleanupFiles(...paths) {
  for (const path of paths.filter(p => p && fs.existsSync(p))) {
    await rimraf(path).catch(err => console.error(`Cleanup failed for ${path}: ${err}`));
  }
}

/**
 * Schedule periodic cleanup of temporary directory
 * @param {string} tmpDir - Temporary directory path
 * @param {number} maxAge - Maximum age in milliseconds
 */
export function schedulePeriodicCleanup(tmpDir, maxAge = 24 * 60 * 60 * 1000) {
  setInterval(async () => {
    if (!fs.existsSync(tmpDir)) return;
    
    const files = fs.readdirSync(tmpDir);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = `${tmpDir}/${file}`;
      const stats = fs.statSync(filePath);
      
      if (now - stats.mtimeMs > maxAge) {
        await cleanupFiles(filePath);
      }
    }
  }, 60 * 60 * 1000); // Run every hour
}