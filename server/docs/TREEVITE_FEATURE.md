# Wave-based invite "Treevite"

## Task breakdown

### Phase 1 — Core Infrastructure

 [x] Implement wave-based invite tree data model
 [x] Track invite tree parent-child relationships in database
 [ ] Create invite code generation and validation service
 [ ] Integrate wave logic into participant onboarding flow - including special login code generation

### Phase 2 — Security & Access Control

 [ ] Block voting/commenting until valid invite code entered
 [ ] Add brute-force protection to invite code entry (eg debounce rate limit)
 [ ] Verify browser location proximity without storing location data (future work)
 [ ] Randomly issue location verification challenges to participants (future work)

### Phase 3 — Admin Tools & Configuration

 [ ] Add admin control to start/stop invite tree
 [ ] Implement manual “Open Next Wave” admin action
 [ ] Configure wave size (first wave only) and invites-per-user settings
 [ ] Allow admins to bulk-generate root invites for classes/events (future work)
 [ ] Support per-conversation invite tree toggle in admin UI
 [ ] Allow flexible branching factor per wave (What is this?)

### Phase 4 — Participant Experience

 [ ] Build invite code entry screen with success/fail feedback
 [ ] Show “Help secure this conversation” public-good prompt (future work)
 [ ] Display participant wave position and invite availability (first wave hipster bragging rights)

### Phase 5 — Demographics & Legitimacy

 [ ] Optional demographic prompt on invite acceptance (age, gender) (future work)
 [ ] Store “Did not answer” for skipped demographic fields (future work)

### Phase 6 — Monitoring & Scaling

 [ ] Display wave/tree growth stats in admin dashboard
 [ ] Handle multi-region scaling for large simultaneous conversations (what is this?)

⸻

## Configuration

### Conversation-level variables

- `treevite_enabled` (boolean): Whether treevites are enabled for this conversation.

## Data Model

- `conversations` (existing table): per-conversation configuration
  - `zid` (number): Primary key
  - `treevite_enabled` (boolean): Whether Treevite is enabled

- `treevite_waves` (table): per-wave configuration and summary
  - `id` (number): Primary key
  - `zid` (number): Conversation id
  - `wave` (number): Wave number (1-based), unique per conversation
  - `parent_wave` (number, optional): Parent wave number; defaults to greatest existing wave for the `zid`, or 0 for root
  - `invites_per_user` (number): Invites granted to each participant in the parent wave
  - `owner_invites` (number, default 0): Owner-controlled invites included in this wave
  - `size` (number, optional): Derived and cached as `(parent_size or 1) * invites_per_user + owner_invites`
  - `created_at` (timestamp)
  - `updated_at` (timestamp)

- `treevite_invites` (table): per-invite records with tree edges
  - `id` (number): Primary key
  - `zid` (number): Conversation id
  - `wave_id` (number): Foreign key to `treevite_waves.id`
  - `parent_invite_id` (number, nullable): Parent invite id (self-reference)
  - `invite_code` (string): Unique per conversation `(zid, invite_code)`
  - `status` (enum smallint): 0=unused, 1=used, 2=revoked, 3=expired
  - `invite_owner_pid` (number, nullable): Participant who owns/distributes the invite
  - `invite_used_by_pid` (number, nullable): Participant who consumed the invite
  - `invite_used_at` (timestamp, nullable)
  - `created_at` (timestamp)
  - `updated_at` (timestamp)

- `treevite_login_codes` (table): per-participant login credential (code) storage
  - `id` (number): Primary key
  - `zid` (number), `pid` (number): Participant composite key
  - `login_code_hash` (text): Slow salted hash (argon2/bcrypt) of the login code; the raw code is never stored
  - `login_code_fingerprint` (string): HMAC-derived fingerprint for fast lookup; unique per conversation `(zid, login_code_fingerprint)`
  - `login_code_lookup` (string): Peppered SHA-256 lookup hash; unique per conversation `(zid, login_code_lookup)` and indexed for O(1) lookup
  - `fp_kid` (smallint): Key id for fingerprint secret rotation
  - `revoked` (boolean, default false): Whether the login code is revoked
  - `expires_at` (timestamp, nullable)
  - `last_used_at` (timestamp, nullable)
  - `created_at` (timestamp)
  - `updated_at` (timestamp)

### Login code lookup (peppered)

- **Goal**: Make login-by-code efficient and secure without scanning all rows.
- **Storage**: For each `login_code`, we store:
  - `login_code_hash` (bcrypt) for secure verification
  - `login_code_lookup` (peppered SHA-256) for fast lookup, where `lookup = sha256(login_code + PEPPER)`
- **Lookup**: On `POST /api/v3/treevite/login`, compute the same lookup hash, fetch one row by `(zid, login_code_lookup)`, then verify with `bcrypt.compare`.
- **Pepper**: Configured via environment variable `LOGIN_CODE_PEPPER` (falls back to `ENCRYPTION_PASSWORD_00001` in dev). The pepper is not stored in the DB.

## API Endpoints

Admin (hybridAuth required; `conversation_id` expected and mapped to `zid`):

- `POST /api/v3/treevite/start`
  - Start Treevite for a conversation; creates initial wave and root invites.
  - Body: `conversation_id` (string), optional overrides: `initial_invite_count` (int)
  - Returns: created wave summary and counts

- `POST /api/v3/treevite/waves`
  - Create a wave for a conversation. Parent defaults to latest wave (or 0 if none).
  - Body: `conversation_id` (string), `invites_per_user` (int, optional), `owner_invites` (int, optional), `parent_wave` (int, optional)
  - Rules: at least one of `invites_per_user` or `owner_invites` must be > 0
  - Returns: wave record with derived `size`

- `GET /api/v3/treevite/waves`
  - List waves for a conversation (optionally a single wave).
  - Query/body: `conversation_id` (string), optional `wave` (int)

- `GET /api/v3/treevite/invites`
  - List invites for a conversation; filterable and paginated.
  - Query/body: `conversation_id` (string), optional filters: `wave_id` (int), `status` (int), `owner_pid` (int), `limit` (int), `offset` (int)

- `POST /api/v3/treevite/invites/revoke`
  - Revoke an invite (or multiple) by id/code/owner.
  - Body: `conversation_id` (string), one of: `invite_id` (int), `invite_code` (string), or `owner_pid` (int)

- `POST /api/v3/treevite/loginCodes/revoke`
  - Revoke participant login codes.
  - Body: `conversation_id` (string), `pid` (int) or `pids` (int[])

Participant:

- `GET /api/v3/treevite/myInvites`
  - View invites owned by the current participant to share with others.
  - Auth: hybridAuth (participant)
  - Query/body: `conversation_id` (string)

- `POST /api/v3/treevite/acceptInvite`
  - Exchange a valid invite code for participation; issues a participant JWT and a login_code (hashed+fingerprint stored server-side).
  - Auth: hybridAuthOptional (works for new or existing sessions)
  - Body: `conversation_id` (string), `invite_code` (string), optional `answers`, `referrer`, `parent_url`
  - Returns: participant JWT, `login_code` (one-time display), and basic wave context

- `POST /api/v3/treevite/login`
  - Submit a login_code to obtain a fresh participant JWT for the conversation.
  - Auth: hybridAuthOptional
  - Body: `conversation_id` (string), `login_code` (string)
  - Returns: participant JWT

- `GET /api/v3/treevite/me`
  - Convenience endpoint for participant Treevite context (e.g., current wave, remaining invites).
  - Auth: hybridAuth (participant)
  - Query/body: `conversation_id` (string)

## Notes

- We need to be able to generate a tree of invites for a given conversation.
- We need to be able to track the parent-child relationships between invites.
- We need to be able to block voting/commenting until a valid invite code is entered.
- A "treevite" participant who registers with a treevite invite code, will remain "anonymous" (no email required), but will receive a
  special login code (distinct from the invite code) that will allow them to login to the conversation.
- This creates a new type of participant, kind of like an "XID" participant. But maybe they can be handled in the same way as anonymous participants (JWT-based).
