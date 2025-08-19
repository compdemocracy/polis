# Wave-based invite "Treevite"

## Task breakdown:

### Phase 1 — Core Infrastructure

 1. Implement wave-based invite tree data model
 2. Track invite tree parent-child relationships in database
 3. Create invite code generation and validation service
 4. Integrate wave logic into participant onboarding flow

### Phase 2 — Security & Access Control

 5. Block voting/commenting until valid invite code entered
 6. Add brute-force protection to invite code entry
 7. Verify browser location proximity without storing location data
 8. Randomly issue location verification challenges to participants

### Phase 3 — Admin Tools & Configuration

 9. Add admin control to start/stop invite tree
 10. Implement manual “Open Next Wave” admin action
 11. Configure per-wave size and invites-per-user settings
 12. Allow admins to bulk-generate root invites for classes/events
 13. Support per-conversation invite tree toggle in admin UI
 14. Allow flexible branching factor per wave

### Phase 4 — Participant Experience

 15. Build invite code entry screen with success/fail feedback
 16. Show “Help secure this conversation” public-good prompt
 17. Display participant wave position and invite availability

### Phase 5 — Demographics & Legitimacy

 18. Optional demographic prompt on invite acceptance (age, gender)
 19. Store “Did not answer” for skipped demographic fields

### Phase 6 — Monitoring & Scaling

 20. Display wave/tree growth stats in admin dashboard
 21. Handle multi-region scaling for large simultaneous conversations

⸻

## Configuration

### Conversation-level variables

- `treevite_enabled` (boolean): Whether treevites are enabled for this conversation.
- `treevite_initial_invite_count` (number): The number of invites to generate for the first wave.
- `treevite_max_waves` (number): The maximum number of waves allowed for this conversation.
- `treevite_wave_invites_per_user` (number): The maximum number of invites per user allowed per wave.

## Data Model

- `treevite_config` (table): per-conversation configuration
  - `zid` (number): The id of the conversation. (primary key)
  - `enabled` (boolean): Whether treevites are enabled for this conversation.
  - `initial_invite_count` (number): The number of invites to generate for the first wave.
  - `max_waves` (number): The maximum number of waves allowed for this conversation.
  - `wave_invites_per_user` (number): The maximum number of invites per user allowed per wave.

- `treevite_invites` (table): per-invite data
  - `zid` (number): The id of the conversation.
  - `wave` (number): The wave number of the invite.
  - `parent_id` (number): The id of the parent invite.
  - `status` (string): The status of the invite.
  - `invite_code` (string): The invite code.
  - `invite_owner_pid` (number): The pid of the user who owns the invite.
  - `invite_used_by_pid` (number): The pid of the user who used the invite.
  - `invite_used_at` (timestamp): The timestamp when the invite was used.

## API Endpoints



## Notes

- We need to be able to generate a tree of invites for a given conversation.
- We need to be able to track the parent-child relationships between invites.
- We need to be able to block voting/commenting until a valid invite code is entered.
- We need to be able to verify browser location proximity without storing location data.
