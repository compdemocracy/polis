# Changing Rust route selection

Every nginx startup renders `RUST_API_ROUTES` from its container environment
(empty by default), including on an initialized routing volume. An unset or
empty list starts all switchable routes on Node regardless of the persisted selection.
`/var/lib/polis-routing/current/routes` records the last applied live selection;
it does not override deployment settings. A hot switch lasts until the next
switch or startup. Persist the desired list in the deployment environment too
if it should survive replacement. `docker compose restart` retains the old
container environment; use the ordinary deployment/recreation flow to apply
changed environment settings.

To keep Rust running without routing requests to it, set `POLIS_API_START=1`
and leave `RUST_API_ROUTES` empty in the normal web deployment environment.
Deployment validation probes Rust's internal health and logs the result. With
no route selected, an unhealthy Rust process does not fail Node's deployment;
with a selected route, Rust health is required. nginx has no dependency on it. This start flag does not change the
map or enable any route. Production commands must include the deployment's
`-f docker-compose.images.yml` override so they use the pulled image digests.
An empty live switch stops Rust after draining, even when the deployment's
start flag is still `1`; that flag applies on the next normal deployment.

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

# Edge routing

The proxy has an explicit route list; see [the routing table](ROUTING.md).
Known assets go to Node, which serves them from `STATIC_FILES_HOST` (the
file-server in development, the static asset origin in production), as before.
Production web boxes run no file-server container, so nginx cannot reach one
directly. Application API and page routes
keep their existing Node or selected Rust destination. Node's catch-all stays
registered for page handling, but unmatched edge paths no longer reach it.

An unmatched path uses `return 404` locally. The njs module already shipped in
the nginx base image formats the same HTML as the file-server's `finalhandler`,
including the method and escaped original path, omitting the query. HEAD has
no body and retains the corresponding content length. No upstream is needed
for this response. `/404.html` is a separate public document, not the body of
an unknown-path response.

The existing routing conformance entry point also checks every emitted asset
in the file-server image, API methods and page families in both route selections,
Node's access log, and local 404s with both Node and file-server stopped:

```sh
queue-rs/polis-api/conformance/nginx-routing.sh
```

For an offline run, supply locally built `NGINX_TEST_IMAGE` and
`NGINX_FILE_SERVER_IMAGE`. The latter must contain the real file-server and
client build outputs. Additional positive fixtures cover newer asset families
when that cached image predates them. `NGINX_RENDERED_DIR` optionally saves
`nginx -T` output for the tested routes-off and routes-on selections. The
harness owns a unique container/network prefix and uses ephemeral loopback
ports. `X54_NGINX_PREFIX` can override that prefix.

### Production upstream check

Run `make check-nginx-upstreams` from the repository root (Python 3.12+ and
`envsubst`, provided by gettext, are required). The Nginx production upstreams
workflow runs the same command for changes to the proxy, Compose file or
production startup hook. No Docker daemon, database or environment file is used.

The check reads the web role's image list and Compose startup commands in
`scripts/after_install.sh`, compares them with `docker-compose.yml` service
names and dependencies, then reads every `.template` and `.conf` file below
the nginx directory. Includes are not followed; included files with other
extensions are outside coverage. It also runs `render-rust-api.sh` with all route templates selected, using the
Compose default Rust upstream. Only the renderer's container-local template
path is relocated to a temporary directory. Literal proxy hosts, upstream
pool members and host variables defined by `set` or `map` must name a service
the web role starts. Exceptions belong in `production_upstreams.py` with an
explanation; the list is currently empty.

This is a source topology check, not a live readiness probe: conditional Rust
startup counts as available when its routes are selected. Deployment-specific
environment overrides, DNS reachability and container health are outside its
scope. The shell and Compose readers support the current explicit startup
and short dependency-list forms, not general shell evaluation or arbitrary
YAML. Unsupported startup arguments, dependencies and host variables fail;
changes to those source forms need matching reader tests. The deployment hook
is never executed. The test includes the short-lived migration invocation in
its startup review but does not count it as a serving upstream.
