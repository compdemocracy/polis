# Polis API Tests

This repository contains the external test suite for the Polis API.

## Prerequisites

- Node.js >= 18.0.0
- Docker
- npm

## Getting Started

### Setup Environment

1. Clone this repository
2. Copy the example environment file:

```bash
cp .env.example .env
```

3. Configure the `.env` file with your specific settings:
   - `API_DOCKER_IMAGE`: Docker image for the API
   - `API_DOCKERFILE_PATH`: Path to the API Dockerfile (default: `../server`)
   - `API_SERVER_PORT`: Port for the API server (default: `5000`)

4. Install dependencies:

```bash
npm install
```

## Available Commands

### Testing

Run the test suite:

```bash
npm test
```

Run tests with debugging enabled:

```bash
npm run test:debug
```

Run tests in watch mode:

```bash
npm run test:watch
```

Generate test coverage report:

```bash
npm run test:coverage
```

### Code Quality

Format code:

```bash
npm run format
```

Lint code:

```bash
npm run lint
```

Lint code with unsafe fixes:

```bash
npm run lint:unsafe
```

Check code for issues:

```bash
npm run check
```

### Docker Management

Prune Docker networks and containers:

```bash
npm run prune
```

## Project Structure

The test suite is built using:

- Jest for testing
- Supertest for API testing
- Testcontainers for Docker integration
- Faker for generating test data
