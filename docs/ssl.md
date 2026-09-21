
# SSL

**Important:** The Docker Compose infrastructure described in the main README uses an insecure, self-signed SSL certificate, which is pre-generated and stored publicly in the source code.
This HTTPS implementation is thus **ONLY suitable for testing.** The current image still copies the public snakeoil key/certificate; see [nginx.Dockerfile:4](../file-server/nginx.Dockerfile#L4).
Frequently, SSL support is something provided at the hosting layer, and we encourage you to pursue this option when possible.

Nevertheless, we would like to find a way to streamline this part of the process as much as possible.
There's been [some progress](https://github.com/compdemocracy/polis/issues/289) to that end, and we encourage you to help push it forward if you're able!

## Details

For testing some functionality, some external services must interact with the Polis app via HTTPS.

To modify these settings, edit [file-server/nginx/nginx-ssl.site.default.conf](../file-server/nginx/nginx-ssl.site.default.conf) before building the `nginx-proxy` Docker container. The image copies it as a template, and [the entrypoint](../file-server/nginx/docker-entrypoint.sh#L8) substitutes `API_SERVER_PORT`; [Compose:249](../docker-compose.yml#L249) supplies that value. Preserve this substitution when customizing the template:

```
edit file-server/nginx/nginx-ssl.site.default.conf
docker compose up --detach --build --no-deps nginx-proxy
```

## Separate application and database TLS settings

The development OIDC simulator has a separate certificate path. The overlays mount `AUTH_CERTS_PATH` and pass `NODE_EXTRA_CA_CERTS` to Node; see [development overlay:21](../docker-compose.dev.yml#L21) and [test overlay:98](../docker-compose.test.yml#L98). These settings do not configure PostgreSQL TLS.

Database TLS is implemented independently by each client. Python's [Postgres client](../delphi/polismath/database/postgres.py#L1) reads `DATABASE_SSL_MODE`; API configuration reads `DATABASE_SSL`. The coordinator [database configuration](../coordinator-rs/src/database.rs#L179) requires an explicit host allowlist and CA bundle, with an optional separate password file. See the [environment reference](configuration-env-reference.md) for the exact read sites and [coordinator substrate](coordinator-substrate.md) for its contract.

No certificate contents or private keys are included in this guide. Configure deployment TLS at the chosen hosting boundary and separately configure each database client using its implemented contract; a local HTTPS proxy does not establish database identity verification.
