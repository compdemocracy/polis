# Offline profile: Polis on one small machine with no network

The offline profile runs Polis on one machine that has no network connection. Participants on the box's local network can vote and see groups and consensus. An admin can create a conversation and read the report. Postgres is the only store in the core tier.

You build and save everything on a machine that has network access. Then you copy one archive to the box and load it there. Nothing is downloaded on the box.

The profile has three parts:
- the compose overlay [`docker-compose.offline.yml`](../docker-compose.offline.yml);
- the env template [`example.offline.env`](../example.offline.env);
- the `make OFFLINE` target in the [Makefile](../Makefile).

[`scripts/offline-bundle.sh`](../scripts/offline-bundle.sh) ships the images. [`ci/offline_compose_config_test.sh`](../ci/offline_compose_config_test.sh) checks the overlay without building anything.

> **Status.** Admin login uses the development OIDC simulator, which has fixed accounts and one fixed password. Read [What still reaches out today](#what-still-reaches-out-today-and-why) before you give a box to anyone.

## Tiers and services

| Service | Tier | What it does here |
|---|---|---|
| postgres | core | The only store. In this profile it always starts, whatever the `postgres` profile says. |
| server | core | API server, production build, run with `OFFLINE=1`, which skips Auth0 Management, Akismet, dd-trace, Google Translate and AWS SES. See [configuration](configuration.md#offline-mode-server). |
| file-server | core | Serves the admin, participation and report clients. They are built with `OFFLINE=1`, so the pages carry no analytics tags. d3 and Plotly are bundled. |
| nginx-proxy | core | Ports 80 and 443. Port 443 serves the mkcert certificate (the same one the issuer uses) instead of the image's built-in test certificate. |
| client-participation-alpha | core | Serves `/alpha/`. It stays in the core tier because nginx proxies to it by name and will not start if that name does not resolve. The legacy page is still the default `/<conversation>` page. |
| math-python | core | The math engine: PCA, groups and consensus. It runs one worker with a 1.5 GB memory limit and uses the container hostname as its identity. It writes the `MATH_ENV` label that the server reads. |
| oidc-simulator | core | Admin login issuer: the development simulator, built and served over HTTPS with mkcert certificates. A local issuer will replace it. |
| delphi | `offline-topics` | Topic pipeline. It uses CPU torch, has the embedding model baked in, runs with `LLM_PROVIDER=ollama` and `OFFLINE=1`, and never pulls a model. |
| ollama | `offline-topics` | Local model server. The model is shipped in the `ollama-models` volume. |
| dynamodb | `offline-topics` | DynamoDB Local. Delphi's job queue and results are kept here until they move to Postgres. |
| minio | `offline-topics` | Object store for Delphi plots. It stays until plots move to the filesystem. |

Not started in either tier: ses-local (mail inbox), localstack and import-worker (CSV vote import), coordinator-idle, and the development-only services.

With `OFFLINE=1` and `SES_ENDPOINT` unset, the server logs each email (subject only) and does not send it.

## Machine sizing

| Tier | RAM | CPU | Disk |
|---|---|---|---|
| Core | 4 GB | 2 vCPU, x86-64 | ~20 GB: about 4 GB of images, plus data |
| Core + `offline-topics` with `llama3.1:8b` | 16 GB | 2 vCPU or more; topic naming on CPU is slow but bounded | ~35 GB: about 6 GB of images, plus the ollama image (~4.75 GB), the model (~4.9 GB) and data |

These figures are standard model sizes and earlier local image sizes, not measurements of this profile. During `load`, peak disk use is about twice the archive: the archive, its extracted copy and the loaded images. The extracted copy is removed when `load` finishes. A 3B-class model (about 2 GB on disk and 3 GB of RAM) brings the topic tier down. arm64 boards are untested.

## 1. Prepare on a machine with network access

The build machine must have the same CPU architecture as the box (x86-64).

1. Install Docker with Compose 2.24.4 or later, plus git, Node.js (for the key generator) and [mkcert](https://github.com/FiloSottile/mkcert).
2. Create the env file and give it the box's name:

   ```bash
   cp example.offline.env offline.env
   # Edit offline.env:
   #   OFFLINE_HOSTNAME        the name or LAN IP that browsers use to reach the box
   #   POSTGRES_PASSWORD and DATABASE_URL (the same password in both)
   #   LOGIN_CODE_PEPPER
   #   OFFLINE_TOPICS=true     if the box runs the topic tier
   ```

   The box's name is fixed at build time. `OFFLINE_HOSTNAME` is compiled into the client images: the admin and report clients' issuer URL, the embed host, and alpha's API URL. If you change it, rebuild and save a new bundle.

3. Create the certificate. nginx (port 443) and the issuer both serve it, so it must name the box. It must also name `oidc-simulator`, which is the name the server uses inside the compose network. Use the exact value of `OFFLINE_HOSTNAME` from step 2:

   ```bash
   mkcert -install
   mkdir -p ~/.simulacrum/certs && cd ~/.simulacrum/certs
   mkcert -cert-file localhost.pem -key-file localhost-key.pem \
     <OFFLINE_HOSTNAME> localhost 127.0.0.1 oidc-simulator
   cp "$(mkcert -CAROOT)/rootCA.pem" ~/.simulacrum/certs/
   cd -
   ```

4. Generate the participant JWT keys: `make generate-jwt-keys`. This writes `server/keys/`.
5. Build the images. `make OFFLINE build` builds the core tier. For the topic tier, run `make OFFLINE_TOPICS=true OFFLINE build`. Both pass `OFFLINE=1`, `BAKE_EMBEDDING_MODEL=true` and `USE_CPU_TORCH=true`.
6. Topic tier only: pull the three upstream images at their pinned digests, then put the model into the volume. `pull` fetches exactly the digests in [`offline-images.lock`](../offline-images.lock), and `save` refuses any other copy, so two bundles carry the same upstream bytes.

   ```bash
   scripts/offline-bundle.sh pull
   C="docker compose -f docker-compose.yml -f docker-compose.offline.yml --env-file offline.env --profile offline-topics"
   $C up -d ollama
   $C exec ollama ollama pull llama3.1:8b   # the OLLAMA_MODEL in offline.env
   $C stop ollama
   ```

7. Optional: run `make OFFLINE start` on the build machine and work through the [acceptance checklist](#acceptance-checklist) before you ship.
8. Save the bundle:

   ```bash
   scripts/offline-bundle.sh save                          # core tier
   scripts/offline-bundle.sh save --topics --with-models   # core + topics + the model volume
   ```

   This writes one archive, `polis-offline-<tier>-<commit>.tar`. It holds:
   - `docker save` of every image the tier runs;
   - a manifest with each image's content id and repo digest;
   - `git archive HEAD` of this checkout;
   - the model volume, if you asked for it;
   - checksums.

   The archive does not contain `offline.env`, the certificates or the JWT keys, because they are secrets. Copy those separately. `save` prints the archive's sha256. Compare it on the box by a separate channel, because the checksums inside the archive only detect damage.

## 2. Install on the box

The box needs Docker Engine with the Compose plugin, `make` and bash, installed from offline packages for its OS. Enable the Docker service at boot (`systemctl enable docker`). Every container has a restart policy, so the stack comes back after a reboot without anyone running `make` again.

```bash
# Unpack the source first; the load script lives in it.
mkdir polis-offline
tar -xOf polis-offline-core-<commit>.tar source.tar | tar -x -C polis-offline
polis-offline/scripts/offline-bundle.sh load polis-offline-core-<commit>.tar --dest polis-offline
```

`load` does four things:
- checks the checksums;
- runs `docker load`;
- refuses to finish unless every image in the manifest is present with the same content id;
- restores the model volume as `polis-offline_ollama-models` (set `COMPOSE_PROJECT_NAME` first if you changed it).

Then put the secrets in place and start:

```bash
cd polis-offline
cp /path/to/offline.env .
cp -r /path/to/keys server/keys                    # from make generate-jwt-keys
mkdir -p ~/.simulacrum && cp -r /path/to/certs ~/.simulacrum/certs
make DETACH=true OFFLINE start
```

**Admins use `https://<OFFLINE_HOSTNAME>/`.** Plain http works only on the box itself. The admin login library (oidc-client-ts) needs `crypto.subtle`, and browsers provide that only in a secure context: `https://`, or `http://localhost`. Over `http://<LAN name or IP>` from another device, login fails. Install `rootCA.pem` on each admin device so that both `https://<OFFLINE_HOSTNAME>/` and the issuer at `https://<OFFLINE_HOSTNAME>:3000/` are trusted. Otherwise, accept the certificate warning once on each of the two.

Participants can use `http://` or `https://` and never touch the issuer.

Admin accounts are the simulator's: `admin@polis.test` and `moderator@polis.test`. Both use the password `Te$tP@ssw0rd*`. The accounts are held in memory and cannot be changed.

## Acceptance checklist

The acceptance test: **a participant can open a conversation, vote, and see groups and consensus with the network cable unplugged; an admin can create a conversation and read the report.**

Run the checks with the network cable unplugged and DNS unreachable, after `docker load` of the shipped archive:

1. `make OFFLINE start` brings every core service up with zero outbound connections.
   - Check that every service is up with `docker compose -f docker-compose.yml -f docker-compose.offline.yml --env-file offline.env ps`.
   - For egress, add a logging deny rule before starting, for example `iptables -I DOCKER-USER -o <uplink> -j LOG --log-prefix "polis-egress "` followed by `iptables -I DOCKER-USER 2 -o <uplink> -j DROP`. Then confirm that `journalctl -k | grep polis-egress` stays empty.
2. A participant opens `/<conversation_id>` on a phone on the box's Wi-Fi. In the browser's network panel, every request goes to the box. Known exception: see the legacy page's pol.is images under [What still reaches out today](#what-still-reaches-out-today-and-why).
3. The participant votes. Each vote lands in `votes`, and math-python writes a new `math_main` row within its poll interval. Open a database shell with `make OFFLINE psql-shell`, then run:

   ```sql
   select zid, math_env, math_tick, last_vote_timestamp, modified from math_main order by modified desc limit 5;
   ```

   Run it again after a vote: `math_tick` goes up.
4. The participant sees groups and consensus. To check, run `curl -sk --compressed "https://<OFFLINE_HOSTNAME>/api/v3/math/pca2?conversation_id=<conversation_id>"`. The response should contain `group-clusters` and `group-aware-consensus`.
5. **From a second device, not the box itself**, an admin logs in at `https://<OFFLINE_HOSTNAME>/`, creates a conversation and seeds comments. A browser on the box passes even over http, so a check made there proves nothing.
6. The admin opens the report. The participant graphs and beeswarm render from the bundled d3 and Plotly, and the report CSVs download.
7. Topic tier: the admin starts a Delphi run. The local model names the topics; if the model is absent, keyword labels do. Narrative and collective statement are not available offline yet.
8. Reboot the box with the cable still unplugged. Without running `make`, `docker ps` lists every service again, the participant page loads, and the egress log from item 1 stays empty.
9. Search the shipped client bundles for third-party hosts:

   ```bash
   docker run --rm --entrypoint sh polis-offline/file-server:offline -c \
     "grep -rhoE 'https?://[a-zA-Z0-9.-]+' /app/build | sort | uniq -c | sort -rn"
   ```

   The only hosts in the output should be the known exceptions below, plus URLs that appear in library source and are never fetched, such as licence and documentation links.

## `DEV_MODE=true` and how to avoid it

`example.offline.env` sets `DEV_MODE=true`, as the test stack does. This makes the production server build use plain-http host handling. It has side effects:
- 500 responses include the error message and stack trace;
- request bodies are written to the log;
- the JSON access log is off;
- the email notification loop does not run;
- the database pool has two connections.

On a closed LAN this is acceptable. To avoid it, set `DEV_MODE=false`. The server then builds absolute links as `https://<API_PROD_HOSTNAME>`, which the https entry on port 443 serves. Every user then has to use `https://`, because plain http links would point at https. This variant has not been run yet.

## What still reaches out today, and why

**Building.** Building needs the network: npm, PyPI, apt, the base images, the baked embedding model and the Ollama model. That is why you build on the build machine and ship images. The box itself never builds.

**The issuer's certificates.** The OIDC simulator serves HTTPS with mkcert certificates. The mkcert binary is downloaded on the build machine, and every admin device has to trust its CA. The simulator also has fixed accounts and a fixed password. A local admin issuer (offline PR 9) replaces it, and that needs a ruling first.

**Runtime gaps in the core tier.** These are not outbound calls that succeed; they fail, or show something empty, when unplugged:
- **Legacy participant page.** It shows the pol.is logo and favicon as `<img>` tags pointing at `https://pol.is/...`, so offline they are broken images. Its footer links to pol.is pages.
- **Admin data export.** It writes to AWS S3 and has no local path, so it fails. The report CSVs at `/api/v3/reportExport/...` come from Postgres and work. Offline PR 10 adds the local path.
- **Correlation matrix.** The report's correlation-matrix panel stays "pending". It has no producer even online.

**Runtime gaps in the topic tier:**
- **Delphi plots.** They are stored in MinIO, so a browser must be able to reach MinIO's URL (`AWS_S3_PUBLIC_ENDPOINT`). Offline PR 11 moves them to the filesystem.
- **DynamoDB Local and MinIO.** These two emulators stay until the job queue moves to Postgres (offline PR 12, P-076). That move is a schema change and needs per-table rulings.
- **Narrative report and collective statement.** Both are Anthropic-only code paths. They fail with "key not set" until an Ollama provider lands (offline PR 13).

## Checking the overlay

```bash
ci/offline_compose_config_test.sh
```

This check runs `docker compose config` and `make -n` only; it builds and starts nothing. It confirms four things:
- each tier lists exactly the services in the table above;
- the rendered core tier contains none of `amazonaws`, `auth0`, `anthropic`, `simpleanalytics` or `googleapis`;
- the topic tier pulls no image from a hosted registry;
- the offline settings are in place: `OFFLINE=1`, the shared `MATH_ENV`, pool 1, the 1.5 GB limit, Ollama, and the build args.

The `Offline compose config` workflow runs the same check on pull requests.
