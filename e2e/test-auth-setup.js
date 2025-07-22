#!/usr/bin/env node

// Load environment variables from .env file if it exists
try {
  require('dotenv').config()
} catch {
  // dotenv not available or .env file doesn't exist
}

/**
 * Quick validation script for Polis auth setup
 * Run this before E2E tests to ensure everything is configured correctly
 */

const https = require('https')
const http = require('http')
const { execSync } = require('child_process')

const config = {
  authAudience: process.env.AUTH_AUDIENCE || 'users',
  authClientId: process.env.AUTH_CLIENT_ID || 'dev-client-id',
  oidcSimulatorUrl: process.env.AUTH_ISSUER || 'https://localhost:3000',
  serverUrl: process.env.CYPRESS_BASE_URL || 'http://localhost',
}

console.log('🔍 Validating Polis Authentication Setup...\n')

async function checkEndpoint(url, description) {
  return new Promise((resolve) => {
    const isHttps = url.startsWith('https:')
    const client = isHttps ? https : http

    const options = {
      method: 'GET',
      timeout: 5000,
      rejectUnauthorized: false, // Allow self-signed certificates
    }

    const request = client.get(url, options, (response) => {
      console.log(`✅ ${description}: ${response.statusCode}`)
      resolve(true)
    })

    request.on('error', (error) => {
      console.log(`❌ ${description}: ${error.message}`)
      resolve(false)
    })

    request.on('timeout', () => {
      console.log(`⏰ ${description}: Timeout`)
      request.destroy()
      resolve(false)
    })
  })
}

async function checkMkcertSetup() {
  try {
    const caRoot = execSync('mkcert -CAROOT', { encoding: 'utf8' }).trim()
    console.log(`✅ mkcert CA root: ${caRoot}`)

    const fs = require('fs')
    const path = require('path')
    // Use workspace-relative path or fallback to HOME for local development
    const certsDir =
      process.env.AUTH_CERTS_PATH ||
      path.join(process.env.HOME || process.cwd(), '.simulacrum', 'certs')

    if (!fs.existsSync(certsDir)) {
      console.log(`❌ Simulacrum certs directory not found at: ${certsDir}`)
      return false
    }

    const files = fs.readdirSync(certsDir)
    const certFile = files.find(
      (f) => f.startsWith('localhost') && f.endsWith('.pem') && !f.includes('-key'),
    )
    const keyFile = files.find((f) => f.startsWith('localhost') && f.endsWith('-key.pem'))
    const rootCAPath = path.join(certsDir, 'rootCA.pem')

    let certsFound = false
    if (certFile && keyFile) {
      const certPath = path.join(certsDir, certFile)
      console.log(`✅ Simulacrum certificates found: ${certFile}, ${keyFile}`)
      certsFound = true

      // Check certificate details
      const certInfo = execSync(
        `openssl x509 -in ${certPath} -text -noout | grep -A 2 "Subject Alternative Name"`,
        { encoding: 'utf8' },
      )
      if (certInfo.includes('localhost') && certInfo.includes('oidc-simulator')) {
        console.log('✅ Certificate covers both localhost and oidc-simulator')
      } else {
        console.log('⚠️  Certificate may not cover all required hostnames')
        certsFound = false
      }
    } else {
      console.log('❌ Simulacrum certificates not found')
    }

    const rootCaFound = fs.existsSync(rootCAPath)
    if (rootCaFound) {
      console.log('✅ Root CA found in simulacrum directory')
    } else {
      console.log('❌ Root CA not found in simulacrum directory')
    }

    return certsFound && rootCaFound
  } catch (error) {
    console.log(`❌ mkcert setup check failed: ${error.message}`)
    return false
  }
}

async function main() {
  console.log('Configuration:')
  console.log(`  OIDC Simulator: ${config.oidcSimulatorUrl}`)
  console.log(`  Server: ${config.serverUrl}`)
  console.log(`  Audience: ${config.authAudience}`)
  console.log(`  Client ID: ${config.authClientId}\n`)

  const checks = [
    () => checkMkcertSetup(),
    () => checkEndpoint(`${config.oidcSimulatorUrl}/.well-known/jwks.json`, 'OIDC Simulator JWKS'),
    () =>
      checkEndpoint(
        `${config.oidcSimulatorUrl}/authorize?response_type=code&client_id=${config.authClientId}`,
        'OIDC Simulator Authorize',
      ),
    () =>
      checkEndpoint(
        `${config.serverUrl}/api/v3/participationInit`,
        'Server API (participationInit)',
      ),
  ]

  const results = []
  for (const check of checks) {
    results.push(await check())
  }

  const passCount = results.filter((r) => r).length
  const totalCount = results.length

  console.log(`\n📊 Results: ${passCount}/${totalCount} checks passed`)

  if (passCount === totalCount) {
    console.log('🎉 All checks passed! Ready for E2E testing.')
    process.exit(0)
  } else {
    console.log('⚠️  Some checks failed. Please review the setup before running E2E tests.')
    console.log('\n💡 Quick fixes:')
    console.log('  - Ensure Docker services are running: make start')
    console.log('  - Check certificates: ls -la ~/.simulacrum/certs/')
    console.log('  - Verify mkcert setup: mkcert -install')
    process.exit(1)
  }
}

main().catch(console.error)
