# Authentication Documentation

Polis is migrating from cookie-based authentication to JWT-based authentication using OIDC for standard users and custom JWTs for XID/anonymous participants.

## Documentation Structure

### [AUTH_ARCHITECTURE.md](./AUTH_ARCHITECTURE.md)

Main overview of the authentication system architecture, including:

- Three types of users (Standard, XID, Anonymous)
- Hybrid authentication middleware
- JWT token structures
- Security considerations

### [XID_JWT.md](./XID_JWT.md)

Complete documentation for XID (External ID) JWT authentication:

- Implementation details
- Authentication flow
- Setup instructions
- Client integration examples

### [auth/README.md](../src/auth/README.md)

Quick reference for the authentication module implementation:

- File structure
- Usage examples
- Environment configuration
- Testing instructions

## Quick Start

1. **For developers implementing authentication**: Start with [AUTH_ARCHITECTURE.md](./AUTH_ARCHITECTURE.md)
2. **For XID integration**: See [XID_JWT.md](./XID_JWT.md)
3. **For code implementation**: Reference [auth/README.md](../src/auth/README.md)
