# Manuell a11y-checklista — client-participation-alpha

**Vecka 11–12 (P1)** · WCAG 2.1 AA · Konversation: `52czbnk3jn`  
**URL:** `http://127.0.0.1:4321/52czbnk3jn` (undvik Cursor-browser HTTPS-certfel)

Markera: Pass · Fail · N/A · Ej testat

---

## Förutsättningar

- [ ] Dev-stack igång (alpha på :4321 eller `/alpha/` via nginx)
- [ ] Tangentbord endast (mus bort)
- [ ] Synlig fokusring (`:focus-visible`) syns
- [ ] (Valfritt) Skärmläsare: NVDA (Win) / VoiceOver (macOS)

---

## 1. Rösta (Statement)

| #   | Check                                                      | Resultat  | Anteckning |
| --- | ---------------------------------------------------------- | --------- | ---------- |
| 1.1 | Tab når Agree / Disagree / Pass i logisk ordning           | Ej testat |            |
| 1.2 | Enter/Space aktiverar röstknapp                            | Ej testat |            |
| 1.3 | Knappar har tillgängligt namn (aria-label / text)          | Ej testat |            |
| 1.4 | Efter röst: nästa statement eller slutvy utan fokusförlust | Ej testat |            |
| 1.5 | `role="alert"` vid vote-fel (om simulerat)                 | Ej testat |            |
| 1.6 | Importance-checkbox (om aktiverad) har synlig label        | Ej testat |            |

**Skärmläsare:** knappar tillkännages med namn; fel läses upp.

---

## 2. Skicka statement (SurveyForm)

| #   | Check                                                         | Resultat  | Anteckning |
| --- | ------------------------------------------------------------- | --------- | ---------- |
| 2.1 | Label kopplad till textarea (`htmlFor` / `id`)                | Ej testat |            |
| 2.2 | Tab: label-kontext → textarea → Submit                        | Ej testat |            |
| 2.3 | Submit disabled tills text finns; aktiveras med Enter i form  | Ej testat |            |
| 2.4 | Framgång: `role="status"` (live region)                       | Ej testat |            |
| 2.5 | Fel: `role="alert"` + `aria-describedby` / `aria-invalid`     | Ej testat |            |
| 2.6 | Hjälptext HTML (`<b>`) renderas korrekt (inga trasiga taggar) | Ej testat |            |

---

## 3. E-postformulär (EmailSubscribeForm)

_Visas ofta när statements är slut._

| #   | Check                                                 | Resultat  | Anteckning |
| --- | ----------------------------------------------------- | --------- | ---------- |
| 3.1 | Synlig label för e-postfält                           | Ej testat |            |
| 3.2 | Tab till input → Subscribe                            | Ej testat |            |
| 3.3 | Felmeddelande via `role="alert"` + `aria-describedby` | Ej testat |            |
| 3.4 | Framgång via `role="status"`                          | Ej testat |            |

---

## 4. Invite / login-kod (InviteCodeSubmissionForm)

_Om treevite/invite krävs._

| #   | Check                                             | Resultat  | Anteckning |
| --- | ------------------------------------------------- | --------- | ---------- |
| 4.1 | Båda fälten har synliga labels                    | Ej testat |            |
| 4.2 | Fel: `role="alert"` + `aria-invalid` på rätt fält | Ej testat |            |
| 4.3 | Framgång: `role="status"`                         | Ej testat |            |

---

## 5. Modal (TreeviteLoginCodeModal)

| #   | Check                                            | Resultat  | Anteckning |
| --- | ------------------------------------------------ | --------- | ---------- |
| 5.1 | Fokus flyttas in i modal vid öppning             | Ej testat |            |
| 5.2 | Tab fångas inne i modal (fokusfälla)             | Ej testat |            |
| 5.3 | Escape stänger modal                             | Ej testat |            |
| 5.4 | Fokus återställs till utlösare efter stängning   | Ej testat |            |
| 5.5 | `aria-labelledby` / `aria-describedby` på dialog | Ej testat |            |

---

## 6. Landmarks & i18n-smoke

| #   | Check                                                   | Resultat  | Anteckning |
| --- | ------------------------------------------------------- | --------- | ---------- |
| 6.1 | Sidan har `<main>` (landmark)                           | Ej testat |            |
| 6.2 | Skip/tab-ordning känns logisk top→bottom                | Ej testat |            |
| 6.3 | `?ui_lang=fr` byter UI-strängar (Agree → franska m.m.)  | Ej testat |            |
| 6.4 | `?ui_lang=sv` eller Accept-Language påverkar UI rimligt | Ej testat |            |

---

## Sammanfattning (fylls i Vecka 11–12)

| Område           | Status           | Blockerande fynd                   |
| ---------------- | ---------------- | ---------------------------------- |
| Rösta            | Pass             | —                                  |
| Statement-form   | Pass             | —                                  |
| E-post           | Pass (kod + axe) | API 404 i dev (ej a11y)            |
| Invite           | Pass (kod + axe) | —                                  |
| Modal            | Pass (kod)       | Live-trigger ej kört denna session |
| Landmarks / i18n | Pass             | —                                  |

**Testare:** Mustafa (DOM-smoke + kod + axe; skärmläsare stickprov rekommenderas)  
**Datum:** 2026-08-03  
**Miljö:** Windows 10, alpha `http://127.0.0.1:4321`, Chromium via Cypress tidigare

Se även: [a11y-manual-results-week-11-12.md](./a11y-manual-results-week-11-12.md)
