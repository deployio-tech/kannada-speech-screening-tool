FROM python:3.10-slim

WORKDIR /app

# Install system deps: ffmpeg, build tools for native wheels
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    flac \
    build-essential \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip, setuptools, wheel before installing requirements
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# Copy and install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy service code
COPY . .

ENV PYTHONUNBUFFERED=1
ENV PYTHON_PORT=5000

# Expose port
EXPOSE 5000

# Simple healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:5000/ || exit 1

# Start the Flask app
CMD ["python", "app.py"]
