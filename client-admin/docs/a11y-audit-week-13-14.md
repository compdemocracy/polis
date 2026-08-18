# Admin a11y — snabb audit (Vecka 13–14 stretch)

**Datum:** 2026-08-03  
**Branch:** `feature/a11y-admin-stretch`  
**App:** `client-admin` (serveras som static via `file-server` / nginx)

## Hur man kör

- Docker: byggd in i `file-server` — öppna `https://localhost/` (admin lander) efter `make DETACH=true rebuild-web`
- Lokalt: `cd client-admin && npm start` (webpack-dev-server)
- Testkonton (dev): `admin@polis.test` / `Te$tP@ssw0rd*`

## Kritiska vyer

| Vy | Fil | Kommentar |
|----|-----|-----------|
| Sign in | `landers/SignIn.js` | En knapp `#signinButton` → OIDC |
| Conversation list | `Conversations.js` | Create + list; superadmin-filter |
| Account | `Account.js` | Endast text, få interaktiva fält |
| Conversation admin | `conversation-admin/*` | Moderation, stats, invite — större yta |

## Fynd (prioritet)

| ID | Severity | Vy | Problem | Föreslagen fix |
|----|----------|-----|---------|----------------|
| A1 | P1 | Conversations (All / superadmin) | Filter-`input`/`select` har bara `placeholder`, ingen `<label>` / `aria-label` | Synliga labels eller `aria-label` på varje kontroll |
| A2 | P1 | Lander layout | Ingen `<main>` landmark i `lander-layout.js` / `MainLayout` | Wrappa content i `<main>` |
| A3 | P2 | Globalt | Ingen tydlig `:focus-visible`-stil i admin theme (jämfört med alpha) | Global focus-visible i theme/CSS |
| A4 | P2 | Sign in | OK knapptext; OIDC-form utanför vår kontroll | Ingen fix i admin (OIDC simulator) |

## Scope för stretch (max 1–3 fixer)

Rekommenderat: **A1 + A2** (labels på filter + `<main>`). A3 om tid finns.

### Åtgärdat (2026-08-03)

- **A1:** Synliga `<label>` + `htmlFor`/`id` på alla superadmin-filter i `Conversations.js`
- **A2:** `<main>` i `lander-layout.js`; `<nav aria-label="Admin">` + `<main>` i `MainLayout.js`
- **A3:** Ej gjort (P2, kvar som rekommendation)

## Metod

Kodgranskning + jämförelse med alpha P0-mönster.

## Verify (2026-08-03)

| Check | Resultat |
|-------|----------|
| `npm run lint` (client-admin) | Pass |
| Jest (`SignIn`/`home`, Docker Node 22) | Pass |
| Kodgranskning A1/A2 | Pass — labels + landmarks på plats |
| Manuell Tab i browser | Rekommenderas efter `rebuild-web` / `npm start` |

**Slutsats:** Stretch-leveransen är lint-ren, Jest grön i Docker, och kodmässigt klar. Full UI-Tab efter rebuild av file-server.
