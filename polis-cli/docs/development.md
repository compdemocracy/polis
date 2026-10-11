# Development configuration

The CLI embeds `defaults.json`; an ordinary install connects to pol.is without
creating a configuration file. That file supplies the origin, default profile,
public issuer, native client ID, audience and registered callback port. The
callback uses HTTP on 127.0.0.1 at that port and the fixed `/oauth/callback` path.
These public registration values are configuration, not secrets.

For development or tests, select a profile with `POLIS_SITE=local` or
`POLIS_SITE=preprod`. The latter needs an origin. Environment settings override
configuration for the matching profile:

```sh
POLIS_SITE=local POLIS_URL_LOCAL=http://127.0.0.1:5000 polis auth status
POLIS_SITE=preprod POLIS_URL_PREPROD=https://polis.example.invalid polis auth status
```

`POLIS_AUTH_ISSUER_<PROFILE>`, `POLIS_AUTH_CLIENT_ID_<PROFILE>`,
`POLIS_AUTH_AUDIENCE_<PROFILE>` and `POLIS_AUTH_CALLBACK_PORT_<PROFILE>` override
OAuth configuration. `POLIS_CA_FILE_<PROFILE>` supplies a development CA file;
`POLIS_TOKEN_<PROFILE>` supplies an access token. Use uppercase profile names in
variable suffixes. Issuer/client/audience must match the selected server; never
reuse production credentials in development. HTTP origins are allowed only on
loopback. Callback port 0 selects an ephemeral port for local simulators; real
provider registrations must use their registered port.

Alternatively put a complete `profiles.json` in `~/.config/polis/`, or set
`POLIS_CONFIG_DIR` to an isolated directory. `profiles.example.json` shows the
format. Existing files remain complete overrides, including their `default`;
upgrading does not rewrite them, move credentials or change their selected server.
`POLIS_SITE` takes precedence over that default without writing the file. Unknown
or unconfigured profiles fail rather than falling back to production. Origins and
auth overrides apply on fresh installs too. Custom names must first exist in the
configuration's `sites` map. Auth entries that omit the callback port retain the shipped default port; use
0 explicitly for ephemeral simulator ports, or the registered port for a provider.

Keep tokens out of profiles.json, command arguments and source control. Saved
credentials remain bound to profile and origin, with OAuth sessions also bound to
issuer, client and audience. Switching configuration does not copy credentials.
Before replacing or removing a profile, run `polis auth logout` with its existing
configuration if you want to erase that profile's saved credentials.

Tests should always use an isolated `POLIS_CONFIG_DIR` and explicit developer
configuration. Run `python3 tests/oidc_flows.py target/release/polis` for local
simulator acceptance; it does not contact the production issuer or API.
