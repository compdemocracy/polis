# Auth0 Simulator

A standalone service that provides a local Auth0-compatible authentication server for development and testing. This service uses the [@simulacrum/auth0-simulator](https://github.com/thefrontside/simulacrum/tree/main/packages/auth0) package to simulate Auth0's authentication flow without requiring a real Auth0 tenant.

## What is it?

The Auth0 Simulator provides:

- **JWT Token Generation**: Issues valid JWT tokens for authenticated users
- **JWKS Endpoint**: Serves JSON Web Key Sets for token verification
- **User Pool Management**: Pre-configured test users for consistent testing
- **HTTPS Support**: Runs on HTTPS with locally trusted certificates
- **Auth0 API Compatibility**: Mimics Auth0's authentication endpoints

## Prerequisites

Before using the Auth0 Simulator, you need to set up locally trusted SSL certificates using `mkcert`.

### One-time Certificate Setup

1. **Install mkcert** (if not already installed):

   ```bash
   # macOS with Homebrew
   brew install mkcert
   brew install nss # if you use Firefox
   
   # Other platforms: https://github.com/FiloSottile/mkcert#installation
   ```

2. **Install the local Certificate Authority**:

   ```bash
   mkcert -install
   ```

   This creates and installs a local CA in your system's trust stores.

3. **Generate certificates for both localhost and Docker service name**:

   ```bash
   mkdir -p ~/.simulacrum/certs
   cd ~/.simulacrum/certs
   mkcert localhost 127.0.0.1 ::1 auth0-simulator
   ```

   This creates a single certificate valid for:
   - `localhost` (browser access)
   - `auth0-simulator` (Docker container access)
   - `127.0.0.1` and `::1` (IP-based access)

## Configuration

The simulator is configured through environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_AUDIENCE` | `users` | JWT audience claim |
| `AUTH_CLIENT_ID` | `dev-client-id` | OAuth2 client ID |
| `AUTH_NAMESPACE` | `https://pol.is/` | Auth0 namespace |
| `AUTH_SIMULATOR_PORT` | `3000` | HTTPS port for the simulator |

## Pre-configured Test Users

The simulator comes with a pool of test users for consistent testing:

### Standard Users (for Auth0 authentication)

- `admin@polis.test` / `Te$tP@ssw0rd*`
- `moderator@polis.test` / `Te$tP@ssw0rd*`
- `jwt.test@polis.test` / `Te$tP@ssw0rd*`

### Additional Test Users

- `test.user.0@polis.test` through `test.user.49@polis.test`
- All use password: `Te$tP@ssw0rd*`

## Usage

### Development (Docker Compose)

The simulator runs automatically when you start the development environment:

```bash
# Start all services including auth0-simulator
make start

# Or with Docker Compose directly
docker compose --profile postgres -f docker-compose.yml -f docker-compose.dev.yml up
```

The simulator will be available at:

- **Browser**: `https://localhost:3000/`
- **Docker containers**: `https://auth0-simulator:3000/`

### Standalone Usage

To run the simulator independently:

```bash
cd auth0-simulator
npm install
npm run dev
```

### Key Endpoints

- **JWKS**: `https://localhost:3000/.well-known/jwks.json`
- **Auth**: `https://localhost:3000/authorize`
- **Token**: `https://localhost:3000/oauth/token`

## Integration with Polis

The Auth0 Simulator integrates with the Polis system for:

1. **Admin/Moderator Authentication**: Standard users authenticate through Auth0-compatible flows
2. **JWT Token Validation**: The Polis server validates tokens using the simulator's JWKS endpoint
3. **Development Testing**: Provides consistent authentication for development and testing

### Important Notes

- **Participants** in Polis conversations use a different JWT system (Anonymous/XID JWTs), not Auth0
- Only **admin users and moderators** use the Auth0 simulator for authentication
- The simulator is for **development and testing only** - never use in production

## Troubleshooting

### Certificate Issues

If you encounter SSL/TLS errors:

1. Verify certificates exist: `ls -la ~/.simulacrum/certs/`
2. Check certificate validity: `openssl x509 -in ~/.simulacrum/certs/localhost.pem -text -noout | grep -A 2 "Subject Alternative Name"`
3. Ensure mkcert CA is installed: `mkcert -install`

### Connection Issues

- **Browser**: Use `https://localhost:3000/`
- **Docker containers**: Use `https://auth0-simulator:3000/`
- **Server logs**: Check with `docker logs polis-dev-auth0-simulator-1`

### Port Conflicts

If port 3000 is in use, change the port:

```bash
# In your .env file
AUTH_SIMULATOR_PORT=3001
```

## Development

### File Structure

```
auth0-simulator/
├── src/
│   └── index.ts          # Main application entry point
├── Dockerfile            # Container configuration
├── package.json          # Dependencies and scripts
└── README.md            # This file
```

### Scripts

- `npm run dev` - Development mode with auto-reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Production mode

### Adding Test Users

To modify the user pool, edit the `createUserPool()` function in `src/index.ts`:

```typescript
// Add custom test users
const customUsers = [
  { email: 'custom@polis.test', name: 'Custom User', password: 'password123' }
];
```

## Security Notes

- The simulator uses locally trusted certificates only
- Never use simulator certificates or users in production
- The local CA created by mkcert is only trusted on your development machine
- Simulator tokens are for development/testing purposes only
