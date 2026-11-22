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

## Participant minter byte contract

`participant-mint.json` records ten inputs with two clock samples each. Every
normal run of `participant-jwt-mint.test.ts` re-mints every input with the real
Node issuer and a fresh in-memory key, and compares its **encoded header and
payload bytes** to the recording. Rust independently re-mints and compares those
same bytes. Decoded-object equality alone would not detect a header or claim
order change. The normal run needs no private fixture key and writes no files.
The identity-recordings entry point includes both Jest files.

The blank-XID case records Node's low-level helper behavior only: the Node
identity path never issues it, and the Rust identity constructor must refuse it.
It therefore has `rust_refused: true` instead of a Rust token. The other nine
cases include both signatures and are verified in both languages. Standard-user
subjects and nonblank XIDs preserve their original bytes, including whitespace.

Run the byte contract from `server`:

```sh
npm run test:unit -- --config __tests__/fixtures/participant-jwt/jest.config.json --runInBand
```

Regenerate the minter recording from the repository root:

```sh
record_dir=$(mktemp -d)
trap 'rm -rf "$record_dir"' EXIT
export POLIS_MINT_RECORD_INPUT="$record_dir/input.json"
(cd queue-rs && cargo test --locked -p polis-auth --test participant_jwt_interop participant_minter_node_recordings_and_fresh_signatures -- --exact)
(cd server && npm run test:unit -- --config __tests__/fixtures/participant-jwt/jest.config.json --runTestsByPath __tests__/unit/participant-jwt-mint.test.ts --runInBand)
unset POLIS_MINT_RECORD_INPUT
(cd queue-rs && cargo test --locked -p polis-auth --test participant_jwt_interop)
(cd server && npm run test:unit -- --config __tests__/fixtures/participant-jwt/jest.config.json --runInBand)
```

Rust first checks the existing recording, then writes an exclusive mode-0600
exchange file containing a disposable key. Node signs with the same key and
requires full-token equality for the nine accepted Rust cases before publishing
the public recording. The blank-XID case stays a Node-only helper recording.
Never commit the exchange file. Regeneration does not bypass Rust's regression
assertions: investigate any mismatch before intentionally updating the contract.
