# JWT Testing Setup Guide

This guide explains how to set up and run JWT-based integration tests for the Polis server.

## Overview

The Polis server has been migrated from legacy cookie-based authentication to JWT-based authentication. The integration tests now support three types of authentication:

1. **OIDC JWT** - For standard users (admin, moderators)
2. **XID JWT** - For external participants with XIDs
3. **Anonymous JWT** - For anonymous participants

## Prerequisites

### 1. Docker

Ensure Docker is running on your system. The OIDC simulator runs in a Docker container.

### 2. Environment Variables

Make sure your `.env` file contains the necessary OIDC configuration:

```bash
# OIDC Simulator Configuration
AUTH_ISSUER=https://localhost:3000/
AUTH_AUDIENCE=users
AUTH_CLIENT_ID=dev-client-id
AUTH_SIMULATOR_PORT=3000
```

## Test User Accounts

The OIDC simulator comes pre-configured with test users:

| Email | Password | Role |
|-------|----------|------|
| `admin@polis.test` | `Te$tP@ssw0rd*` | Admin |
| `moderator@polis.test` | `Te$tP@ssw0rd*` | Moderator |
| `test.user.0@polis.test` | `Te$tP@ssw0rd*` | Standard User |
| `test.user.1@polis.test` | `Te$tP@ssw0rd*` | Standard User |
| ... | ... | ... |

## Test Structure

### Anonymous JWT Tests

- Test anonymous participant initialization
- Verify JWT issuance on voting
- Test anonymous voting flows

### XID JWT Tests  

- Test XID participant creation and JWT issuance
- Verify XID JWT claims and validation
- Test cross-conversation participation

### Hybrid Authentication Tests

- Test endpoints that work with both authenticated and unauthenticated requests
- Verify JWT middleware compatibility

## Troubleshooting

### OIDC Simulator Not Starting

```bash
# Check if the container is running
docker ps | grep oidc-simulator

# Check container logs
docker logs oidc-simulator

# Restart the container
docker restart oidc-simulator
```

### Connection Refused Errors

- Ensure Docker is running
- Check that port 3000 is not in use by another service
- Verify the simulator container is healthy: `docker ps`

### JWT Token Errors

- Check that the OIDC simulator is accessible at `https://localhost:3000`
- Verify environment variables are correctly set
- Ensure test users exist in the simulator

### Test Failures

- Check that the database is properly set up
- Verify that conversations and comments exist for testing
- Look for domain whitelist issues in test logs

## Development Workflow

1. **Run tests** to verify JWT functionality
2. **Check logs** for any authentication issues
3. **Debug** using the simulator's endpoints if needed

## Simulator Endpoints

The OIDC simulator provides these endpoints for testing:

- `https://localhost:3000/.well-known/openid_configuration` - OpenID configuration
- `https://localhost:3000/.well-known/jwks.json` - JSON Web Key Set
- `https://localhost:3000/oauth/token` - Token endpoint
- `https://localhost:3000/userinfo` - User info endpoint
