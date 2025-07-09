# Development Server Guide

This project now supports a webpack development server for fast development with hot module replacement and automatic reloading.

## Quick Start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the development server:

   ```bash
   npm run dev
   # or
   npm start
   ```

3. Open your browser to `http://localhost:3001`

## Environment Configuration

You can customize the development environment by creating a `.env` file in the project root:

```bash
# .env file
API_URL=http://localhost:5000
PORT=3001
CONVERSATION_ID=9t6ra4ikkf
GA_TRACKING_ID=UA-XXXXXXXXX-X
EMBED_SERVICE_HOSTNAME=localhost
```

### Environment Variables

- **API_URL**: Backend API server URL (default: `http://localhost:5000`)
- **PORT**: Development server port (default: `3001`)
- **CONVERSATION_ID**: Optional conversation ID to auto-navigate to
- **GA_TRACKING_ID**: Optional Google Analytics tracking ID
- **EMBED_SERVICE_HOSTNAME**: Hostname for embed service (default: `pol.is`)

## Features

### Hot Module Replacement

Changes to JavaScript and CSS files will automatically reload in the browser without losing application state.

### API Proxying

The dev server automatically proxies `/api` requests to your backend server (configured via `API_URL`).

### Source Maps

Full source maps are enabled in development mode for easier debugging.

### Auto-Opening

If you set a `CONVERSATION_ID`, the browser will automatically open to that conversation's URL.

## Available Scripts

- `npm start` / `npm run dev` - Start development server
- `npm run build:dev` - Build for development (without server)
- `npm run build:prod` - Build for production
- `npm run watch` - Watch mode (builds on file changes)

## Troubleshooting

### Port Already in Use

If port 3001 is already in use, either:

- Set `PORT=3002` (or another port) in your `.env` file
- Or run: `PORT=3002 npm run dev`

### API Connection Issues

- Ensure your backend server is running on the URL specified in `API_URL`
- Check the browser's network tab for failed API requests
- The dev server logs will show proxy requests

### Environment File Not Loading

- Ensure your `.env` file is in the project root
- Check that variable names match exactly (case-sensitive)
- Restart the dev server after changing environment variables
