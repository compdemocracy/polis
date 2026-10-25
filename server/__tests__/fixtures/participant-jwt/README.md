# Participant JWT cross-verification tests

`recordings.json` contains a generated test public key and 27 pairs of Rust- and
Node-minted tokens: anonymous, XID, and standard-user, each with nine cases.
These public fixtures contain test identities. No production or private keys are recorded.

The Rust integration test checks both signers with RS256, issuer, audience and
zero clock tolerance at a fixed clock. It also exercises the serving participant
verifier: anonymous and standard-user scalar audiences pass; XID and array
audiences still hand back to Node. The opt-in `verify_for_request` also accepts
valid XID recordings and checks their UID, PID, kind and XID. These tests do not
enable either case in serving code, create identities, or establish database
membership.

The Jest test uses `createJwtValidation`, including the real `express-jwt`
middleware. Both signers must pass the valid and matching-array-audience cases;
`exp == now`, wrong audience, wrong issuer, future `nbf`, RS384, unsigned
`alg: none`, and HS256 signed with the public PEM must fail. The HS256 tokens
carry a correct HMAC keyed with the public PEM text, so the refusal comes from
the verifier's algorithm check, not from signing. The dedicated Jest
configuration avoids the normal suite's database/server setup. Rust tests
require no Node installation when replaying the recordings.

From `queue-rs`:

```sh
cargo test --locked -p polis-auth
```

From `server` (after `npm ci`):

```sh
npm run test:unit -- --config __tests__/fixtures/participant-jwt/jest.config.json --runTestsByPath __tests__/unit/participant-jwt-interop.test.ts --runInBand
```

To regenerate from the repository root, with Rust and Node dependencies ready:

```sh
record_dir=$(mktemp -d)
trap 'rm -rf "$record_dir"' EXIT
export POLIS_JWT_RECORD_INPUT="$record_dir/input.json"
(cd queue-rs && cargo test --locked -p polis-auth --test participant_jwt_interop mint_cross_verification_fixtures -- --exact)
(cd server && npm run test:unit -- --config __tests__/fixtures/participant-jwt/jest.config.json --runTestsByPath __tests__/unit/participant-jwt-interop.test.ts --runInBand)
unset POLIS_JWT_RECORD_INPUT
(cd queue-rs && cargo test --locked -p polis-auth)
```

The Rust test generates one RSA-2048 key pair and writes an exclusive, mode-0600
exchange file. During recording, Jest uses that same pair with the real Node
minter (`issueParticipantJWT`), checks each kind's complete claim set, then
re-signs boundary/error variants. It writes the public recording only after all
54 signature/claim/middleware checks pass. Review the changed recording and
remove the temporary exchange file; never commit it. Normal test runs replay
the public recording without changing it. Every normal Jest run also generates
a fresh RSA pair, mints all three kinds with `issueParticipantJWT`, and compares
their complete headers and payloads with the valid recordings. Added, renamed
or retyped claims therefore fail without regeneration. Regenerate deliberately
when changing the claim contract or JWT dependencies.
