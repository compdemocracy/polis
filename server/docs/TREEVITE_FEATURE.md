# Wave-based invite "Treevite"

## Task breakdown

### Phase 1 — Core Infrastructure

 [x] Implement wave-based invite tree data model
 [x] Track invite tree parent-child relationships in database
 [x] Create invite code generation and validation service
 [x] Integrate wave logic into participant onboarding flow - including special login code generation

### Phase 2 — Security & Access Control

 [x] Block voting/commenting until valid invite code entered
 [ ] Add brute-force protection to invite code entry (eg debounce rate limit)
 [ ] Verify browser location proximity without storing location data (future work)
 [ ] Randomly issue location verification challenges to participants (future work)

### Phase 3 — Admin Tools & Configuration

 [x] Add admin control to start/stop invite tree
 [x] Implement manual “Open Next Wave” admin action
 [x] Configure waves' owner invites and invites-per-user settings
 [x] Allow admins to bulk-generate root invites for classes/events (future work)
 [x] Support per-conversation invite tree toggle in admin UI
 [x] Allow flexible branching factor per wave (What is this?)

### Phase 4 — Participant Experience

 [x] Build invite code entry screen with success/fail feedback
 [x] Add a "My Invites" page that shows the participant's own invites and allows them to share them with others
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

**Currently Implemented:**

Admin (hybridAuth required; `conversation_id` expected and mapped to `zid`):

- `POST /api/v3/treevite/waves`
  - Create a wave for a conversation. Parent defaults to latest wave (or 0 if none).
  - Auth: hybridAuth (admin required)
  - Body: `conversation_id` (string), `invites_per_user` (int, optional), `owner_invites` (int, optional), `parent_wave` (int, optional)
  - Rules: at least one of `invites_per_user` or `owner_invites` must be > 0
  - Returns: wave record with derived `size` and `invites_created` count
  - Creates owner invites immediately + retroactively creates participant invites for existing parent wave members

- `GET /api/v3/treevite/waves`
  - List waves for a conversation (optionally a single wave).
  - Auth: hybridAuth (admin required)
  - Query/body: `conversation_id` (string), optional `wave` (int)
  - Returns: array of wave records

- `GET /api/v3/treevite/invites`
  - List owner invites for a conversation (excludes participant-owned invites).
  - Auth: hybridAuth (admin required)
  - Query/body: `conversation_id` (string), optional `wave_id` (int), `status` (int), `limit` (int), `offset` (int)
  - Returns: object with `invites` array and `pagination` metadata (limit, offset, total, hasMore)

Participant:

- `GET /api/v3/treevite/myInvites`
  - View unused invites owned by the current participant to share with others.
  - Auth: hybridAuth (participant)
  - Query/body: `conversation_id` (string)
  - Returns: array of invite records with `id`, `invite_code`, `status`, `created_at`
  - Returns empty array if user hasn't participated in the conversation yet

- `POST /api/v3/treevite/acceptInvite`
  - Exchange a valid invite code for participation; creates participant and issues JWT + login_code in one step.
  - Auth: hybridAuthOptional (works for new or existing sessions)
  - Body: `conversation_id` (string), `invite_code` (string, 1-128 chars)
  - Returns: `status`, `wave_id`, `invite_id`, `login_code`, and `auth` object with JWT token
  - Flow: validates invite → creates participant if needed → marks invite as used → creates invite codes for child waves → issues JWT and login_code
  - Works with existing authenticated users or creates new anonymous participants
  - Lazily creates invite codes for all existing child waves of the wave they joined

- `POST /api/v3/treevite/login`
  - Submit a login_code to obtain a fresh participant JWT for the conversation.
  - Auth: hybridAuthOptional
  - Body: `conversation_id` (string), `login_code` (string, 1-256 chars)
  - Returns: `status` and `auth` object with JWT token

- `GET /api/v3/treevite/me`
  - Get current participant's Treevite context including wave info and owned invites.
  - Auth: hybridAuth (participant)
  - Query/body: `conversation_id` (string)
  - Returns: object with `participant` (pid, zid), `wave` (wave info + join date), `invites` array
  - Returns null values if user hasn't participated in the conversation yet

**Not Yet Implemented:**

Admin:

- `POST /api/v3/treevite/start` - Start Treevite for a conversation; creates initial wave and root invites
- `POST /api/v3/treevite/invites/revoke` - Revoke invites by id/code/owner
- `POST /api/v3/treevite/loginCodes/revoke` - Revoke participant login codes

Participant:

(All participant endpoints have been implemented)

## Notes

### Invite Code Creation Patterns

The system uses two complementary approaches to ensure all participants get their invite codes:

1. **Retroactive Creation (when wave is created)**:
   - Admin creates new child wave with `invites_per_user: X`
   - System immediately creates X invite codes for all existing participants in the parent wave
   - Handles participants who joined the parent wave before the child wave existed

2. **Lazy Creation (when participant accepts invite)**:
   - New participant accepts invite and joins a wave
   - System finds all existing child waves of the wave they joined
   - Creates invite codes for each child wave based on that wave's `invites_per_user` setting
   - Handles participants who join parent waves after child waves were already created

This ensures every participant gets exactly the right number of invite codes for each applicable wave, regardless of timing.

### Technical Notes

- Tree structure tracks parent-child relationships between invites
- Participants remain "anonymous" (no email required) but receive login codes for session continuity
- Treevite participants use JWT-based authentication similar to anonymous participants
- Access control blocks voting/commenting until valid invite code is entered
