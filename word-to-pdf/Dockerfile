FROM public.ecr.aws/lambda/nodejs:18

# Install system dependencies
RUN yum update -y && \
    yum install -y python3.8 python3-pip libreoffice-headless && \
    yum clean all

# Copy and install Node.js dependencies
COPY package.json package-lock.json ${LAMBDA_TASK_ROOT}/
RUN npm ci --production

# Copy application code
COPY functions/processWordToPdf.js ${LAMBDA_TASK_ROOT}/functions/
COPY functions/word_to_pdf.py ${LAMBDA_TASK_ROOT}/functions/
COPY lib/ ${LAMBDA_TASK_ROOT}/lib/

# Set handler
CMD ["functions/processWordToPdf.handler"]