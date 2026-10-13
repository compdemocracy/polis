# Admin a11y — leverans Vecka 13–14 (stretch)

**Branch:** `feature/a11y-admin-stretch`  
**Datum:** 2026-08-03  
**Audit:** [a11y-audit-week-13-14.md](./a11y-audit-week-13-14.md)

## Vad som levereras

Begränsad a11y-förbättring i `client-admin` (P1), i linje med alpha-mönster från tidigare veckor.

| ID | Fix | Filer |
|----|-----|-------|
| A1 | Synliga labels + `htmlFor`/`id` på superadmin-filter | `Conversations.js` |
| A2 | Landmarks: `<main>`, `<nav aria-label="Admin">` | `lander-layout.js`, `MainLayout.js` |

## Medvetet utanför scope

- **A3** global `:focus-visible` (P2)
- Conversation-admin moderation/stats/invite (större yta)
- OIDC sign-in-formulär (extern simulator)

## PR-text (kopiera)

**Titel:** `Vecka 13-14: Admin a11y stretch (P1)`

```markdown
## Summary
- Lägger synliga labels på superadmin conversation-filter (`Conversations.js`)
- Lägger till `<main>` / `<nav>` landmarks i lander- och MainLayout

## Test plan
- [ ] `cd client-admin && npm run lint`
- [ ] Manuell: logga in som admin, öppna All Conversations (superadmin) och Tab genom filterfält
- [ ] Manuell: kontrollera att lander/signin och inloggad app har en `main`-landmark (devtools)

## Notes
- Stretch-scope; se `client-admin/docs/a11y-audit-week-13-14.md`
- Base: `feature/a11y-manual-i18n` (eller aktuell a11y-stack-tip)
```
