/**
 * Cleanup utilities for serverless converter
 */
const fs = require('fs');
const { rimraf } = require('rimraf');

/**
 * Clean up temporary files
 * @param {...string} paths - Paths to clean up
 * @returns {Promise<void>}
 */
async function cleanupFiles(...paths) {
  for (const path of paths.filter(p => p && fs.existsSync(p))) {
    await rimraf(path).catch(err => console.error(`Cleanup failed for ${path}: ${err}`));
  }
}

module.exports = { cleanupFiles };