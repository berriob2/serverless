# Serverless Converter

A serverless file conversion service built with AWS Lambda and the Serverless Framework. This service provides various file conversion capabilities including PDF to Word, HEIC to JPG, image to PDF, video format conversions, and PDF page manipulation.

## Features

- PDF to Word conversion
- HEIC to JPG conversion
- Image to PDF conversion
- Video format conversion
- Video to MP3 extraction
- PDF page extraction
- PDF page removal
- Job progress tracking
- Secure file downloads with pre-signed URLs

## Architecture

This project uses the following AWS services:

- **AWS Lambda** for serverless compute (2048 MB memory, 15-minute timeout)
- **Amazon S3** for file storage with 7-day lifecycle rules for automatic cleanup
- **Amazon DynamoDB** for persistent job tracking and progress monitoring
- **API Gateway** for HTTP endpoints with rate limiting and throttling
- **IAM** for secure, least-privilege access control

The architecture follows serverless best practices:

1. Files are uploaded to Lambda via API Gateway
2. Files are stored in S3 with appropriate lifecycle policies
3. Job information is tracked in DynamoDB for persistence across Lambda invocations
4. Conversion is performed in Lambda with optimized memory and timeout settings
5. Progress is tracked in real-time and accessible via API
6. Completed files are securely shared via pre-signed S3 URLs

## Prerequisites

- Node.js 18.x or later
- AWS CLI configured with appropriate credentials
- Serverless Framework CLI
- Python 3.x (for PDF to Word conversion)

## Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Install the Serverless Framework globally (if not already installed):

```bash
npm install -g serverless
```

## Configuration

The service is configured using environment variables and the `serverless.yml` file. The main configuration parameters are:

- `AWS_BUCKET_NAME`: S3 bucket for file storage (automatically created during deployment)
- `TMP_DIR`: Directory for temporary file storage (defaults to `/tmp` in Lambda)

## Deployment

To deploy the service to AWS:

```bash
npm run deploy
```

For production deployment:

```bash
npm run deploy:prod
```

## API Endpoints

The service exposes the following API endpoints:

- `POST /convert/pdf-to-word`: Convert PDF to Word
- `POST /convert/heic-to-jpg`: Convert HEIC to JPG
- `POST /convert/image-to-pdf`: Convert images to PDF
- `POST /convert/video`: Convert video formats
- `POST /convert/video-to-mp3`: Extract audio from video
- `POST /convert/extract-pdf-pages`: Extract pages from PDF
- `POST /convert/remove-pdf-pages`: Remove pages from PDF
- `GET /download`: Download converted files
- `GET /progress/{jobId}`: Check job progress

## Usage

All conversion endpoints accept file uploads and return a job ID. The job ID can be used to check progress and download the converted file when ready.

### File Limitations

- **Maximum file size**: 100 MB
- **Supported input formats**:
  - PDF: For PDF to Word conversion and PDF page manipulation
  - HEIC: For HEIC to JPG conversion
  - Images (JPG, PNG, GIF, BMP, WEBP): For image to PDF conversion
  - Videos (MP4, AVI, MOV, WEBM, MKV, FLV, 3GP, WMV): For video conversions and audio extraction
  - Audio (MP3, WAV, FLAC, OGG, AAC, M4A): For audio format conversions

### Example: Converting PDF to Word

```bash
# Upload a PDF file
curl -X POST -F "file=@document.pdf" https://your-api-url.com/convert/pdf-to-word
# Response: {"jobId": "123e4567-e89b-12d3-a456-426614174000", "status": "processing"}

# Check job progress
curl https://your-api-url.com/progress/123e4567-e89b-12d3-a456-426614174000
# Response: {"jobId": "123e4567-e89b-12d3-a456-426614174000", "status": "processing", "progress": 50}

# Download the converted file when completed
curl https://your-api-url.com/download?jobId=123e4567-e89b-12d3-a456-426614174000
# Response: {"downloadUrl": "https://presigned-s3-url.com/...", "filename": "document.docx", "expiresIn": 3600}
```

### Example: Converting Video to MP3

```bash
# Upload a video file
curl -X POST -F "file=@video.mp4" -F "quality=high" https://your-api-url.com/convert/video-to-mp3
# Response: {"jobId": "123e4567-e89b-12d3-a456-426614174000", "status": "processing"}

# Check job progress
curl https://your-api-url.com/progress/123e4567-e89b-12d3-a456-426614174000
# Response: {"jobId": "123e4567-e89b-12d3-a456-426614174000", "status": "processing", "progress": 75}

# Download the converted file when completed
curl https://your-api-url.com/download?jobId=123e4567-e89b-12d3-a456-426614174000
# Response: {"downloadUrl": "https://presigned-s3-url.com/...", "filename": "audio.mp3", "expiresIn": 3600}
```

## Monitoring and Troubleshooting

### Common Error Codes

- **400**: Bad Request - Missing required parameters or invalid input
- **413**: Payload Too Large - File exceeds the 100 MB size limit
- **415**: Unsupported Media Type - File format not supported
- **429**: Too Many Requests - Rate limit exceeded
- **500**: Internal Server Error - Conversion process failed

### Viewing Logs

To view the Lambda function logs:

```bash
npm run logs -- -f convertVideoToMp3 -t 1h
```

Replace `convertVideoToMp3` with the specific function name you want to monitor.

### Monitoring Job Status

Jobs can have the following statuses:

- `uploading`: File is being uploaded to S3
- `processing`: File is being converted
- `completed`: Conversion completed successfully
- `failed`: Conversion failed

## License

MIT