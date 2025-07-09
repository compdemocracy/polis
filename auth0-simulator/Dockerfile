# Use an official Node.js runtime as a parent image
FROM node:lts-slim

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json (or yarn.lock)
COPY package*.json ./

# Install app dependencies
RUN npm install

# Bundle app source
COPY . .

# Creates a "dist" folder with the production build
RUN npm run build --if-present

# Your app binds to port 3000 so you'll use the EXPOSE instruction to have it mapped by the Docker daemon
EXPOSE 3000

# Define the command to run your app
CMD [ "node", "dist/index.js" ] 