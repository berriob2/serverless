FROM node:18-slim

# Install Python and pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files and install Node.js dependencies
COPY package*.json ./
RUN npm install

# Copy Python requirements and install Python dependencies
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV TMP_DIR=/tmp

# Create tmp directory
RUN mkdir -p /tmp

# Expose port for serverless-offline
EXPOSE 3000

# Command to run the application
CMD ["npm", "run", "start"]