/**
 * Utility functions for serverless converter
 */

/**
 * Parse FFmpeg timemark to seconds
 * @param {string} timemark - Timemark in format HH:MM:SS.MS
 * @returns {number} - Time in seconds
 */
function parseTimemark(timemark) {
  const parts = timemark.split(':');
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parseFloat(parts[2]);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Get duration of a media file using FFmpeg
 * @param {string} filePath - Path to the media file
 * @param {object} ffmpeg - FFmpeg instance
 * @returns {Promise<number>} - Duration in seconds
 */
function getDuration(filePath, ffmpeg) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration);
    });
  });
}

/**
 * Truncate a filename if it's too long
 * @param {string} name - Original filename
 * @param {number} maxLength - Maximum length
 * @returns {string} - Truncated filename
 */
function truncateFileName(name, maxLength = 40) {
  if (name.length <= maxLength) return name;
  return `${name.substring(0, maxLength - 3)}...`;
}

/**
 * Validate page ranges for PDF operations
 * @param {string} pageRange - Page range string (e.g., "1-3,5,7-9")
 * @param {number} totalPages - Total number of pages in the PDF
 * @returns {Array<number>} - Array of page indices (0-based)
 */
function parsePageRange(pageRange, totalPages) {
  const pages = new Set();
  const ranges = pageRange.split(',');
  
  for (const range of ranges) {
    if (range.includes('-')) {
      const [start, end] = range.split('-').map(num => parseInt(num.trim(), 10));
      if (isNaN(start) || isNaN(end) || start < 1 || end > totalPages || start > end) {
        throw new Error(`Invalid page range '${range}'. Pages must be between 1 and ${totalPages}.`);
      }
      for (let i = start; i <= end; i++) pages.add(i - 1);
    } else {
      const pageNum = parseInt(range.trim(), 10);
      if (isNaN(pageNum) || pageNum < 1 || pageNum > totalPages) {
        throw new Error(`Invalid page number '${range}'. Pages must be between 1 and ${totalPages}.`);
      }
      pages.add(pageNum - 1);
    }
  }
  
  return Array.from(pages);
}

module.exports = { parseTimemark, getDuration, truncateFileName, parsePageRange };