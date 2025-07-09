// Type definitions to extend Express types for our specific needs

// Add global declarations
declare global {
  namespace Express {
    interface Request {
      p: any;
      timedout?: boolean;
    }
  }
}

// This is necessary to make the TypeScript compiler recognize this as a module
export {};
