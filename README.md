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

- AWS Lambda for serverless compute
- Amazon S3 for file storage
- API Gateway for HTTP endpoints

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

### Example: Converting PDF to Word

1. Upload a PDF file to `/convert/pdf-to-word`
2. Receive a job ID in the response
3. Check job progress at `/progress/{jobId}`
4. When status is `completed`, download the file from `/download?jobId={jobId}`

## License

MIT