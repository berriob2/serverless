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