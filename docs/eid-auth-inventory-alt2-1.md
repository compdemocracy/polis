# Alt 2.1 — Auth-inventering (OIDC / JWT / XID)

**Författare:** Mustafa Salahuddin  
**Spår:** Alternativ 2 / Spår A — BankID & Freja eID (OIDC-broker)  
**Datum:** 2026-08-18  
**Branch:** `feature/eid-auth-inventory`

## Syfte

Kartlägga befintlig autentisering i Polis och var en svensk e-legitimation (BankID/Freja via OIDC-broker, t.ex. Idura) naturligt hakar in — utan att implementera eID ännu.

## Befintlig arkitektur (kort)

| Aktör | Idag | Token |
|-------|------|--------|
| Admin / moderator | OIDC (Auth0 eller lokal `oidc-simulator`) | OIDC Bearer → `hybrid-jwt` |
| Deltagare (standard) | OIDC-inloggad användare som deltar | Conversation-scoped **Standard User JWT** (`oidc_sub`) |
| Deltagare (XID) | Extern ID via URL `?xid=` | **XID JWT** (conversation-scoped) |
| Deltagare (anonym) | Ingen inloggning | **Anonymous JWT** efter första röst/kommentar |
| Legacy | Cookie `pc` | Migreras till JWT |

**Middleware:** `server/src/auth/hybrid-jwt.ts` — prioritet: XID JWT → Anonymous JWT → Standard User JWT → OIDC JWT → legacy cookie.

**Nyckel docs:** `server/docs/authentication.md`, `client-participation-alpha/XID-IMPLEMENTATION.md`, `client-participation-alpha/README-AUTH.md`.

**Nyckelfiler:**

- Server: `hybrid-jwt.ts`, `xid-jwt.ts`, `standard-user-jwt.ts`, `anonymous-jwt.ts`, `oidc_user_mappings`
- Alpha: `src/lib/auth.ts`, `src/lib/net.ts`, `XidOidcConflictWarning`
- Dev OIDC: `AUTH_ISSUER=https://localhost:3000/` (simulator), `AUTH_CLIENT_ID`, JWKS

## Var eID (OIDC-broker) bör hakas in

Enligt praktikplanen (A1 — huvudleverans): **OIDC-broker för deltagare** (alpha + server), inte native BankID SDK.

| Lager | Vad som behövs |
|-------|----------------|
| **Organisation** | Idura (eller liknande) sandbox: klient, redirect URI, testanvändare BankID/Freja |
| **Env** | Pekar `AUTH_ISSUER` / JWKS mot broker (samma mönster som dagens OIDC) |
| **Server** | Claim-mapping: broker `sub` → `oidc_user_mappings` / uid; **ingen lagring av personnummer** — endast `sub` (+ ev. hashad pseudonym). Ev. `acr`/`amr` för LOA (A4, valfritt) |
| **Alpha** | Inloggningsknapp → AuthProvider / OIDC redirect; efter login: Polis-deltagar-JWT som idag för standard users |
| **Policy** | Konversation: `xid_required` / whitelist idag; ny flagga t.ex. `eid_required` eller återanvänd OIDC-krav |
| **Konflikt** | XID + OIDC samtidigt — redan varnad i UI; eID-login måste ha tydlig regel (eID vinner / XID förbjuden / etc.) |

### Rekommenderad integrationsväg (från praktikplan)

| Kod | Väg | Prioritet |
|-----|-----|-----------|
| **A1** | OIDC-broker för deltagare | Huvudleverans |
| A2 | XID från extern gateway | Snabb pilot / komplement |
| A3 | OIDC-broker för admin | Parallellt möjligt |
| A4 | LOA/acr-krav | Valfritt i MVP |
| A5 | Native BankID SDK | **Ej i scope** |

## Vad som fungerar lokalt vs kräver broker

| Aktivitet | Lokalt nu | Kräver org/broker |
|-----------|-----------|-------------------|
| Lära OIDC/JWT/XID-flöden | Ja — simulator + JWT-keys | — |
| Spike mot Idura sandbox | Delvis (när konto finns) | Ja — Idura-avtal/sandbox |
| Riktig BankID/Freja-login | Nej | Ja — broker + test-eID |
| Cypress E2E med eID-testusers | Nej | Ja — sandbox testusers |
| Produktion | Nej | Swedbank-godkännande via Idura (lång ledtid) |

## Risker (kort)

- GDPR / personnummer — dataminimering (bara broker-sub)
- XID vs OIDC i embed-scenarier
- Blocker: Idura-konto måste lösas av organisationen
- Admin OIDC och deltagar-eID kan dela broker men ha olika klienter/claims

## Nästa steg (Alt 2.2)

1. Bekräfta med mentor om Idura-sandbox finns / när  
2. Jämföra broker-alternativ (Idura, Sweden Connect, …) kort  
3. Spike: mock OIDC-login i alpha → standard-user JWT  
4. Alt 2.3: PoC/PR när sandbox finns

## Checklista Alt 2.1

- [x] Läst `server/docs/authentication.md`
- [x] Förstått admin OIDC vs participant JWT vs anonym/XID
- [x] Noterat var eID hakar in (broker → OIDC → standard user JWT i alpha)
- [x] Denna inventeringsanteckning
