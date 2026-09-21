# Database arguments for fixture and projection tools

`prodclone_extract.py`, `certify_data.py`, `projection_gate.py` and the
`poller_equiv.py` database options refuse passwords in command arguments.
This includes URI userinfo, percent-encoded query parameters, libpq keyword
`password=`, and nested connection strings. Invalid syntax also fails with a
fixed error that does not repeat the supplied argument.

For libpq connections, use a passwordless URI with `PGPASSFILE` pointing to a
private mode-0600 file, or `passfile=` / a configured libpq service. Never paste
a password into the command: rejection cannot erase shell history or the
original process argument. The projection witness receives only the admitted
passwordless value. Credential-file/service support is still backend-specific;
libpq service strings are not an assertion of JDBC or Node service resolution.

The helper validates connection-string syntax with the existing psycopg2/libpq
parser. No new dependency is introduced.
