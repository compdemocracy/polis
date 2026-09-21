# Inactive coordinator deployment

`CoordinatorInactiveService` adds a separate 0.25-vCPU / 512-MiB ARM64 Fargate
service to the existing VPC. Its desired count defaults to zero. It does not
replace the Clojure math service or apply database migrations. The dedicated
`coordinator-idle` executable has no writer, worker-dispatch or migration command.

Starting one task is a later operational decision. These prerequisites must
already exist; this code does not create them:

* A service login named `polis_coordinator_observer_login`, with only inherited
  membership in the `polis_coordinator_observer` group and no elevated attributes,
  public-table write privileges or executable `pc_*` routines. The group remains
  **NOLOGIN**. Never use the RDS administrator secret. Migration 000021's absence
  is not permission to manufacture the group or alter its login flag here.
* A Secrets Manager secret containing `username` and `password` for that login,
  using the Secrets Manager service-managed encryption key. Supply its complete
  ARN; no secret value is a CloudFormation parameter. A customer-managed key
  needs separately reviewed execution-role decrypt wiring before use.
* A reviewed image built for `linux/arm64` from
  `coordinator-rs/deploy/Dockerfile`, published to `polis/coordinator` in the
  stack's account/region, with its exact manifest digest recorded.

The stack creates the retained ECR repository. Initial dormant deployment needs
the selected image digest and existing secret ARN, even though no task starts.
Image publication is a separate operator step, not a side effect of synthesis.

| CloudFormation parameter | Value |
|---|---|
| `CoordinatorInactiveImageDigest` | Reviewed `sha256:` plus 64 lowercase hex digits; no mutable tag |
| `CoordinatorInactiveLoginSecretArn` | Existing observer-login secret ARN; the referenced password is secret |
| `CoordinatorInactiveDesiredCount` | `0` normally; `1` only for the later idle-start go |

The password-free DSN is
`postgresql://polis_coordinator_observer_login@<primary-endpoint>:<primary-port>/polisdb?sslmode=verify-full`.
The primary endpoint and port come directly from the stack's RDS instance, and
the allowlist contains exactly that endpoint. The task execution role can read
only the imported login secret and pull its ECR image. The task role has no
added AWS permissions. HTTPS egress supports image, secret and log delivery;
PostgreSQL egress is restricted to the database security group.

ECS injects the two secret fields into the bootstrap environment. The shell
entrypoint verifies the username, writes the password using a shell builtin to
`/run/coordinator/password` under umask077, restricts it to mode0600, removes both
bootstrap variables, then execs the idle process. The task root is read-only;
the password volume is private ephemeral task storage. The idle process requires
a password-file setting and refuses embedded DSN passwords.
The Dockerfile declares the same `VOLUME` path and sets its owner to uid10001,
following [ECS bind-mount ownership rules](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/bind-mounts.html).

The RDS global CA bundle is downloaded **at image build**, verified against
SHA256 `e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3`
(the existing reviewed probe CA pin), and baked at `/etc/polis/rds-ca.pem`.
There is no runtime CA fetch or fallback to system roots. The Docker Official
Rust and Debian base images are pinned by manifest digest. No crate was added.

After verified TLS, the process sets a read-only session, checks its own TLS
connection, login/group attributes, effective memberships and prohibited
privileges through catalog SELECTs. It rolls back that read-only transaction,
prints the fixed token `COORDINATOR_IDLE_VERIFIED`, and sleeps between checks.
It never reads application payloads, writes coordinator rows, calls `pc_*`, or
touches `polis_coordinator_writer_authority`. Missing roles or conflicting
privileges refuse startup; they are not repaired. Failure output is a fixed
token without a driver exception or DSN.

`COORDINATOR_MODE=inactive`, `COORDINATOR_WRITER_ENABLED=false` and
`P026_RESERVATION_BYTES=0` are the only admitted settings. Omission defaults to
those safe values. Setting any other value refuses startup; changing them does
not activate writing. Stop the idle service by restoring desired count zero.

## Local parity and review

Both primary and test Compose files contain a `coordinator-idle` profile,
disabled by default. The local service invokes the same idle binary directly
and reads externally supplied files; it does not inject secrets into environment
variables. Supply `COORDINATOR_DATABASE_URL` without a password,
`COORDINATOR_DB_HOST_ALLOWLIST`, `COORDINATOR_PASSWORD_FILE` and
`COORDINATOR_CA_FILE`. The mounted password must be readable by uid10001 and
owner-only; missing host files are not created. No default database role/grant
or TLS configuration is added to the existing Compose PostgreSQL service.

```sh
docker build --platform linux/arm64 -f coordinator-rs/deploy/Dockerfile -t polis/coordinator-idle:local .
docker compose --profile coordinator-idle config
```

The isolated admission rehearsal owns only its explicitly named project and
loopback port; its public role/table fixture does not apply migration 000021:

```sh
cargo build --manifest-path coordinator-rs/Cargo.toml --locked --bin coordinator-idle
COMPOSE_PROJECT_NAME=p027-idle-review POLIS_RECOVERY_PG_PORT=55566 RECOVERY_PG_PORT=55566 python3 -B coordinator-rs/deploy/test_idle.py
```

Use an unused project/port. The rehearsal checks TLS, idle state, privilege drift,
password/host/mode refusals and preservation of its canary/catalog. Deployment,
secret provisioning, migration installation and writer activation are outside
this local verification.
