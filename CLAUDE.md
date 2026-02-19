# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Polis is an AI-powered democratic engagement platform for large-scale opinion gathering. It uses real-time machine learning to cluster participants and surface representative comments.

## Development Commands

### Primary Commands (via Makefile)

```bash
make start                    # Start full dev environment (uses .env)
make start-rebuild            # Start with rebuild
make stop                     # Stop all containers
make PROD start               # Production mode (uses prod.env)
make DETACH=true start        # Run in background
```

### Service-Specific Rebuilds

```bash
make rebuild-server           # Rebuild server (auto-restarts on code changes)
make rebuild-web              # Rebuild client web apps (file-server + client-participation-alpha)
make rebuild-delphi           # Rebuild delphi ML service
```

### Database Operations

```bash
make psql-shell               # Open psql shell
make refresh-db               # Drop DB volume and reinitialize
make refresh-prodclone        # Reinitialize from prodclone.dump

# Direct psql access
psql postgresql://postgres:oiPorg3Nrz0yqDLE@localhost:5432/polis-dev
```

### Testing

```bash
make e2e-run                  # Run E2E tests (Cypress)
make e2e-run-interactive      # Open Cypress GUI

# Server unit tests (run inside container or with local node)
cd server && npm test
cd server && npm run test:unit
cd server && npm run test:integration

# Client-participation-alpha
cd client-participation-alpha && npm run lint
cd client-participation-alpha && npm run format
cd client-participation-alpha && npm run verify  # format + lint + build
```

### E2E Test Categories

```bash
cd e2e
npm run test:admin            # Admin interface tests
npm run test:alpha            # Alpha client tests
npm run test:auth             # Authentication tests
npm run test:participation    # Participation & embed tests
npm run test:conversation     # Conversation workflow tests
```

## Architecture

### Services (Docker Compose)

- **server** (Node.js/TypeScript) - REST API, handles votes, comments, conversations
- **math** (Clojure) - Legacy ML: PCA dimensionality reduction, K-means clustering
- **delphi** (Python) - Modern ML: UMAP, topic modeling, LLM narrative synthesis
- **client-participation-alpha** (Astro/React) - Participant-facing UI
- **file-server** - Serves static assets for client-admin and client-report
- **nginx-proxy** - Routes requests to appropriate services
- **postgres** - Primary data store
- **dynamodb** - Delphi job queue and results storage
- **ollama** - Local LLM inference (optional)
- **minio** - S3-compatible storage for dev

### Key Directories

```
server/           # Node.js API (TypeScript)
math/             # Clojure ML service
delphi/           # Python ML service (see delphi/CLAUDE.md for details)
client-admin/     # Admin console (React/Webpack)
client-participation-alpha/  # Participant UI (Astro/React)
client-report/    # Analytics/reports (React/D3)
file-server/      # Static file serving + nginx config
e2e/              # Cypress E2E tests
docs/             # Configuration and deployment docs
```

### Data Flow

1. Participants submit votes/comments via client apps
2. Server stores in PostgreSQL and triggers math/delphi processing
3. Math service polls DB, runs PCA/K-means, writes results back
4. Delphi service uses DynamoDB job queue for UMAP/LLM processing
5. Results displayed in client-report and admin dashboards

## Key Terminology

- **zid** - conversation ID (internal)
- **pid** - participant ID
- **tid** - comment (statement) ID
- **PCA** - Principal Component Analysis (dimensionality reduction)
- **UMAP** - Uniform Manifold Approximation (modern dimensionality reduction)

## Development Environment

### Prerequisites

1. Docker and Docker Compose
2. mkcert for SSL certificates (required for OIDC simulator)
3. JWT keys for participant auth

### First-Time Setup

```bash
# Install SSL certificates
brew install mkcert nss
mkcert -install
mkdir -p ~/.simulacrum/certs
cd ~/.simulacrum/certs
mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost 127.0.0.1 ::1 oidc-simulator host.docker.internal
cp "$(mkcert -CAROOT)/rootCA.pem" ~/.simulacrum/certs/

# Generate JWT keys
make generate-jwt-keys

# Start
cp example.env .env
make start
```

### Test Accounts (Dev Mode)

- `admin@polis.test` / `Te$tP@ssw0rd*`
- `moderator@polis.test` / `Te$tP@ssw0rd*`
- `test.user.0@polis.test` through `test.user.49@polis.test` (same password)

### Ports

- 80/443: nginx-proxy (main entry point)
- 5000: server API (direct, dev only)
- 4321: client-participation-alpha
- 5432: PostgreSQL
- 8000: DynamoDB local
- 9000/9001: MinIO (S3)
- 11434: Ollama

## Configuration

Environment variables are documented in `docs/configuration.md`. Key files:
- `.env` - Development config (copy from `example.env`)
- `prod.env` - Production config
- `test.env` - Test config

### Docker Compose Profiles

- `--profile postgres` - Include containerized PostgreSQL
- `--profile local-services` - Include DynamoDB, MinIO, SES local emulators

## Service-Specific Development

### Server (Node.js/TypeScript)

The server auto-rebuilds and restarts on TypeScript changes when running in dev mode. Key patterns:

- Express 3.x API (legacy)
- PostgreSQL via `pg` library
- TypeScript with strict mode
- Jest for testing
- Auto-reload via nodemon in dev mode

Commands:
```bash
cd server
npm run dev               # Build watch + nodemon
npm run build             # TypeScript compile
npm run format            # Prettier formatting
npm run lint              # ESLint
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests only
```

### Client-Participation-Alpha (Astro/React)

Modern participant UI with Astro SSR and React components. Does NOT auto-rebuild in Docker.

Commands:
```bash
cd client-participation-alpha
npm run dev               # Local dev server (port 4321)
npm run build             # Production build
npm run preview           # Preview production build
npm run lint              # ESLint
npm run format            # Prettier formatting
npm run verify            # format + lint + build
```

Key structure:
- `src/pages/` - Astro routes
- `src/components/` - React components (visualization, surveys, topics)
- `src/api/` - Centralized API client
- `src/strings/` - 30+ language translations

### Delphi (Python ML)

See `delphi/CLAUDE.md` for comprehensive Delphi documentation including:
- DynamoDB table schemas
- Job queue system
- Pipeline execution
- Debugging procedures

Key debugging:
```bash
# View Delphi logs
docker logs polis-dev-delphi-1

# Check job results in DynamoDB (contains FULL system logs)
docker exec polis-dev-delphi-1 python -c "
import boto3, json
dynamodb = boto3.resource('dynamodb', endpoint_url='http://dynamodb:8000', region_name='us-east-1')
table = dynamodb.Table('Delphi_JobQueue')
# List recent jobs or get specific job by ID
"
```

## Common Workflows

### Updating Client UI

Since client apps don't auto-rebuild in Docker:

```bash
# Make changes in client-participation-alpha
make DETACH=true rebuild-web  # Rebuilds file-server + client-participation-alpha
```

### Database Queries

```bash
# Open psql shell
make psql-shell

# Common queries
SELECT zid, topic FROM conversations WHERE LOWER(topic) LIKE '%keyword%';
SELECT COUNT(*) FROM votes WHERE zid = 123;
SELECT COUNT(DISTINCT pid) FROM participants WHERE zid = 123;
```

### Viewing Logs

```bash
docker logs polis-dev-server-1         # Server logs
docker logs polis-dev-delphi-1         # Delphi logs
docker logs polis-dev-math-1           # Math service logs
docker logs polis-dev-nginx-proxy-1    # Nginx logs
```

## Troubleshooting

### Full Reset

```bash
make start-FULL-REBUILD       # Nuclear option: removes all containers, volumes, images
```

### .env Changes Not Taking Effect

```bash
make start-recreate           # Recreate containers with new env
```

### Port 5000 Conflict (Mac)

Disable AirPlay Receiver in System Settings, or change `API_SERVER_PORT` in `.env`.

### Client Changes Not Showing

Client apps (client-admin, client-participation-alpha) are pre-built and served as static assets via file-server. They don't auto-rebuild:

```bash
make DETACH=true rebuild-web  # Rebuild and restart web containers
```

### Server Changes Not Auto-Reloading

Server should auto-rebuild on TypeScript changes. If not:

```bash
make rebuild-server           # Force rebuild server container
```

## API Authentication

### Participant Authentication

- JWT-based using keys in `server/keys/`
- XID (cross-identity) system for SSO
- OIDC simulator for development

### Admin Authentication

- Email/password or OIDC
- Test accounts listed above

## Key API Endpoints

Server runs on port 5000 (dev) or via nginx proxy on 80/443:

- `/api/v3/conversations` - Conversation CRUD
- `/api/v3/comments` - Submit/retrieve comments
- `/api/v3/votes` - Submit votes
- `/api/v3/participationInit` - Initialize participant session
- `/api/v3/participants` - Participant data
- `/api/v3/math/pca2` - PCA visualization data
- `/api/v3/delphi/*` - Delphi ML results

## Build System

### Docker Build Args

- `TAG` - Image tag (from .env)
- `GIT_HASH` - Git commit hash
- `POSTGRES_DOCKER` - Use containerized PostgreSQL
- `LOCAL_SERVICES_DOCKER` - Use local service emulators

### Production Builds

```bash
make PROD start               # Use prod.env configuration
make build-web-assets         # Build and extract static assets to build/
```

## Testing Strategy

1. **Unit Tests** - Server TypeScript code
2. **Integration Tests** - API endpoints with database
3. **E2E Tests** - Full user workflows via Cypress
4. **Manual Testing** - Use test accounts above

## Performance Considerations

- Server uses `--max_old_space_size=2048` for Node memory
- Math service processes conversations in batches
- Delphi uses job queue for async processing
- Client-participation-alpha uses SSR for initial load