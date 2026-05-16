FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package manifests and install dependencies
COPY package*.json ./

# Use npm ci when lockfile exists, fallback to npm install
RUN set -eux; \
    if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --no-audit --no-fund --omit=dev; \
    fi

# Copy the app source
COPY . .

# Set env
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/ || exit 1

# Start the Node application
CMD ["npm", "start"]
