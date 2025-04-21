# Build stage
FROM public.ecr.aws/lambda/nodejs:18 AS builder

WORKDIR /build

# Install build tools & Python dependencies
RUN yum install -y \
    bzip2-devel \
    gcc \
    gzip \
    libffi-devel \
    libjpeg-devel \
    libpng-devel \
    make \
    openssl-devel \
    tar \
    wget \
    zlib-devel \
    && yum clean all

# Install Python 3.8
RUN wget https://www.python.org/ftp/python/3.8.12/Python-3.8.12.tgz \
    && tar -xzf Python-3.8.12.tgz \
    && cd Python-3.8.12 \
    && ./configure --enable-optimizations \
    && make altinstall \
    && cd .. \
    && rm -rf Python-3.8.12 Python-3.8.12.tgz

# Verify Python 3.8 installation
RUN /usr/local/bin/python3.8 --version

# Install pip
RUN curl -O https://bootstrap.pypa.io/get-pip.py \
    && /usr/local/bin/python3.8 get-pip.py \
    && rm -rf get-pip.py

# Install Python dependencies
COPY requirements.txt .
RUN /usr/local/bin/python3.8 -m pip install --no-cache-dir -r requirements.txt -t /build/python

# Install Node.js dependencies
COPY package.json package-lock.json ./
RUN npm ci --production

# Create a package.json in the functions directory to specify CommonJS
RUN mkdir -p /build/functions
RUN echo '{"type": "commonjs"}' > /build/functions/package.json

# Copy Python and JavaScript function code
COPY functions/pdf_to_word.py /build/functions/
COPY functions/processPdfToWord.js /build/functions/
# Copy the lib directory containing helper modules
COPY lib/ /build/lib/

# Final stage - ensure we're using the x86_64 Lambda image
FROM public.ecr.aws/lambda/nodejs:18-x86_64

WORKDIR ${LAMBDA_TASK_ROOT}

# Copy Python and Node.js dependencies
COPY --from=builder /build/python ${LAMBDA_TASK_ROOT}/python
COPY --from=builder /build/node_modules ${LAMBDA_TASK_ROOT}/node_modules
# Copy Python 3.8 binary and libraries
COPY --from=builder /usr/local/bin/python3.8 /usr/local/bin/python3.8
COPY --from=builder /usr/local/lib /usr/local/lib

# Copy function code and lib directory
COPY --from=builder /build/functions/ ${LAMBDA_TASK_ROOT}/functions/
COPY --from=builder /build/lib/ ${LAMBDA_TASK_ROOT}/lib/

# Set environment variables for Python
ENV PYTHONPATH=${LAMBDA_TASK_ROOT}/python
ENV PATH=/usr/local/bin:${LAMBDA_TASK_ROOT}/python/bin:${PATH}
ENV LD_LIBRARY_PATH=/usr/local/lib:${LD_LIBRARY_PATH}
ENV NODE_OPTIONS="--no-warnings"

# Ensure python3.8 is executable
RUN chmod +x /usr/local/bin/python3.8

# Set the handler - make sure this matches exactly what AWS Lambda expects
CMD ["functions/processPdfToWord.handler"]