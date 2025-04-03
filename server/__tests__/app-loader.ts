/* eslint-disable no-console */
/**
 * This module provides controlled loading of the main Express app
 * to avoid issues with the Jest environment and async loading.
 * 
 * Instead of directly importing app.ts, tests should use this loader
 * which manages the initialization timing more carefully.
 */

import { Express } from 'express';

// Cache the app instance to avoid multiple initializations
let appInstance: Express | null = null;
let appInitPromise: Promise<Express> | null = null;
let isAppReady = false;

/**
 * Asynchronously get the Express app instance, waiting for proper initialization
 * @returns Promise resolving to Express app when ready
 */
async function getApp(): Promise<Express> {
  if (isAppReady && appInstance) {
    return appInstance;
  }
  
  if (!appInitPromise) {
    // Create the initialization promise only once
    // Promise executor should not be async
    appInitPromise = new Promise<Express>((resolve, reject) => { 
      try {
        // Load the app
        const app = require('../app').default as Express;
        appInstance = app;
        
        // Wait for any asynchronous initialization to complete
        // Express itself doesn't have built-in ready events, but we can use
        // helpers initialization promise that's available in our app
        // Use a minimal delay to ensure any internal initialization is complete
        setTimeout(() => {
          isAppReady = true;
          resolve(app);
        }, 100);

      } catch (err) {
        console.error('AppLoader: Error loading app:', err);
        reject(err);
      }
    });
  }
  
  return appInitPromise;
}

export { getApp };