FROM node:20-alpine

ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV:-production}

# Add this line to accept the build argument
ARG PUBLIC_SERVICE_URL

# Add this line to set it as an environment variable for the build process
ENV PUBLIC_SERVICE_URL=$PUBLIC_SERVICE_URL

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 4321

CMD ["node", "dist/server/entry.mjs"]
