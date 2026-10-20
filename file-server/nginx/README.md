# Changing Rust route selection

Every nginx startup renders `RUST_API_ROUTES` from its container environment
(empty by default), including on an initialized routing volume. An unset or
empty list starts all routes on Node regardless of the persisted selection.
`/var/lib/polis-routing/current/routes` records the last applied live selection;
it does not override deployment settings. A hot switch lasts until the next
switch or startup. Persist the desired list in the deployment environment too
if it should survive replacement. `docker compose restart` retains the old
container environment; use the ordinary deployment/recreation flow to apply
changed environment settings.

After installing this nginx image, apply the desired complete route list from
the repository root, with the same Compose project and files as the running
stack:

```sh
bash scripts/rust-api-switch.sh pca2 -p polis -f docker-compose.yml
bash scripts/rust-api-switch.sh '' -p polis -f docker-compose.yml
```

For an installation using the standalone Compose executable, set
`POLIS_COMPOSE_BIN=/usr/local/bin/docker-compose`. Existing route-specific Rust
flags, database configuration, grants and admission restrictions still apply;
this command does not enable additional Rust handlers or change their defaults.

The command validates the candidate, reloads nginx to Node, and waits for old
workers to finish their responses. It then starts/reconfigures only `polis-api`,
checks its health from nginx's network, and reloads the selected routes. An empty
list stops only `polis-api`, after the drain. Nginx, Node and their dependencies
are never recreated by this command. An absent Rust upstream cannot prevent
all-off nginx startup; existing per-route DNS and fallback rules are unchanged.

Rendering creates an immutable generation and atomically swaps its directory
link. A rejected render or `nginx -t` restores the prior generation without a
reload. The default drain deadline is 30 seconds. If the deadline is exceeded,
the command fails and leaves Rust running: it never kills a response that has
already sent headers. Inspect the active selection and retry after the old
workers finish, or retry immediately: the retry also waits for every earlier
shutting-down worker. Rust health has at most 30 attempts, each with a 2-second request
timeout and a 1-second interval; failure leaves selection on Node.

A switch temporarily routes all selected reads through Node. Routes without a
Node equivalent retain their existing fallback limitations. This is not a
blue/green rollout of Node or nginx and does not remove interruption from the
first installation of a new nginx image or a normal application deployment.

A lifecycle lock and a render lock serialize changes. The render lock uses
`flock`: a process/container crash releases it automatically. Never remove
`/var/lib/polis-routing/render.flock`, since a new inode could bypass a live
lock. Old `render.lock` directories are ignored, including at startup.
After replacing a dead container, its obsolete directory can be removed with
`docker compose exec nginx-proxy rmdir /var/lib/polis-routing/render.lock`;
this cleanup is optional and has no effect on the current lock.

The separate `switch.lock` directory protects the whole host-driven lifecycle.
If that caller is killed without cleanup, confirm it has exited and inspect
nginx's workers and the upstream before removing the stale directory. Startup
does not take that lifecycle lock. Do not run independent reload or Compose
recreation commands during a switch.

First installation replaces the nginx image once; it can interrupt requests.
An empty startup environment now guarantees Node-only bootstrap on both fresh
and initialized volumes. After readiness, apply the desired list with the
helper. Full application deployment and any proposed route-only deployment
integration remain separate from this helper.

Local Docker checks, also callable by CI:

```sh
bash file-server/nginx/test-rust-reload.sh
queue-rs/polis-api/conformance/nginx-routing.sh
```

The first creates a unique project, exercises concurrent read/write streams,
invalid candidates, environment authority after replacement, crash recovery,
live-lock exclusion, failed health checks and immediate retry during draining,
then removes only that project's containers, network, volume and built image
tag. Diagnostic logs are printed before cleanup. The second is
the existing route-contract suite; set `X54_NGINX_PREFIX` uniquely when sharing a
Docker host.
