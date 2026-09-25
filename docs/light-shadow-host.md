# Light shadow host

A dedicated ARM64 host that runs the Python math poller against the production
database under `MATH_ENV=python-shadow`, next to the Clojure math service,
which keeps writing and serving `MATH_ENV=prod`. It is built the way the Python
engine will run after the cutover, so at the switch this host becomes the
production math host. The code is [cdk/lightShadow.ts](../cdk/lightShadow.ts).

## What it is

- Its own stack, `LightShadowStack`, built only with
  `-c enableLightShadow=true` and `LIGHT_SHADOW_CONFIG=<file.json>`. Without the
  flag nothing is added and `CdkStack` is byte-identical.
- One `t4g.large` (Graviton, 2 vCPU / 8 GiB) in an Auto Scaling group of 0..1 in
  the PrivateWithEgress subnets, with no public address, no SSH key, IMDSv2 only
  and an encrypted gp3 root volume. The `LightShadowInstanceCount` parameter
  defaults to `0`, so a deploy creates the infrastructure but no instance.
- The image is the delphi `final` image for `linux/arm64`, pinned by digest in
  the stack's own immutable repository `polis/math-python`. The host refuses an
  unpinned or non-arm64 image.
- The database credential is the secret the Clojure math service reads today
  (SSM `/polis/db-secret-arn`). The container reads it from Secrets Manager into
  process memory ([launch.py](../cdk/lightShadow/launch.py)) and hands over to
  `scripts/math_poller.py`. It is never written to disk, never on a command line
  and never in the container configuration. The role can read that one secret
  and no other.
- Guards, each enforced twice (synth-time configuration check, and the on-host
  start script plus the launcher): `MATH_ENV` must be exactly `python-shadow`
  (`prod` is refused), and `DATABASE_SSL_MODE` must be `require`.
- Network: no ingress; egress to the database security group on 5432 and HTTPS
  on 443. The stack adds one ingress rule on the database security group from the
  host's security group.
- Logs go to CloudWatch Logs `/polis/light-shadow/math` (one-month retention).
  Host memory and disk go to the `Polis/LightShadow` metric namespace.
- No Lambda, no custom resource, no schema, migration or grant change.

## Operating it

The run switch is the SSM parameter `/polis/light-shadow/run`. The stack
creates it as `off`. The systemd unit `polis-math-shadow` starts the container
only when it reads exactly `on` (`ExecCondition`); an unreadable switch counts as
off, so a reboot or instance replacement cannot restart a stopped shadow.

Start (after the stack is deployed and the image is pushed):

```sh
aws ssm put-parameter --name /polis/light-shadow/run --value on --overwrite
aws ssm send-command --document-name AWS-RunShellScript \
  --targets Key=tag:polis:role,Values=light-shadow \
  --parameters 'commands=["systemctl start polis-math-shadow"]'
```

Stop, the kill switch (a tick in flight is one transaction and rolls back):

```sh
aws ssm put-parameter --name /polis/light-shadow/run --value off --overwrite
aws ssm send-command --document-name AWS-RunShellScript \
  --targets Key=tag:polis:role,Values=light-shadow \
  --parameters 'commands=["systemctl stop polis-math-shadow; docker rm -f polis-math-shadow || true"]'
```

To remove the instance entirely, redeploy with `LightShadowInstanceCount=0`.
The CodeDeploy production deploy does not target this host, so production
deploys do not stop the shadow.

## At the switch

Moving this host to `MATH_ENV=prod` is a separate reviewed change that lifts the
refusal and is made together with stopping the Clojure writer. This stack alone
can never write `prod` rows.
