#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Create keys directory if it doesn't exist
const keysDir = path.join(__dirname, '../keys');
if (!fs.existsSync(keysDir)) {
  fs.mkdirSync(keysDir, { recursive: true });
}

// Generate RSA key pair
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem'
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem'
  }
});

// Write keys to files
const privateKeyPath = path.join(keysDir, 'jwt-private.pem');
const publicKeyPath = path.join(keysDir, 'jwt-public.pem');

fs.writeFileSync(privateKeyPath, privateKey);
fs.writeFileSync(publicKeyPath, publicKey);

console.log('JWT keys generated successfully:');
console.log('Private key:', privateKeyPath);
console.log('Public key:', publicKeyPath);
console.log();
console.log('Environment variables (for containerized deployments):');
console.log('AUTH_KEYS_PATH=' + privateKeyPath);
console.log('AUTH_KEYS_PATH=' + publicKeyPath);
console.log();
console.log('Or base64 encoded for environment variables:');
console.log('JWT_PRIVATE_KEY=' + Buffer.from(privateKey).toString('base64'));
console.log('JWT_PUBLIC_KEY=' + Buffer.from(publicKey).toString('base64')); 