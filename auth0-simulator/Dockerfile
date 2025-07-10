# Use an official Node.js runtime as a parent image
FROM node:lts-slim

# Install curl for health checks, openssl for certificate generation, and create certificate directory
RUN apt-get update && apt-get install -y curl openssl && rm -rf /var/lib/apt/lists/* && \
    mkdir -p /root/.simulacrum/certs

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json (or yarn.lock)
COPY package*.json ./

# Install app dependencies
RUN npm install

# Bundle app source
COPY . .

# Ensure TypeScript is built
RUN npm run build

# Your app binds to port 3000 so you'll use the EXPOSE instruction to have it mapped by the Docker daemon
EXPOSE 3000

# Health check to ensure the service is ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -k -f https://localhost:3000/.well-known/jwks.json || exit 1

# Define the command to run your app
CMD [ "node", "dist/index.js" ] 