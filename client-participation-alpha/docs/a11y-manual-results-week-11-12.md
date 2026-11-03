# A11y manuell testning & i18n — resultat (Vecka 11–12)

**Datum:** 2026-08-03  
**Branch:** `feature/a11y-manual-i18n`  
**Konversation:** `52czbnk3jn`  
**URL:** `http://127.0.0.1:4321/52czbnk3jn`  
**Checklista:** [a11y-manual-checklist.md](./a11y-manual-checklist.md)

## Metod

1. **Kodgranskning** av P0/P1-ändringar (labels, live regions, fokus, modal)
2. **DOM-smoke** via SSR-HTML (`curl` mot alpha)
3. **Automatiserade axe-tester** från Vecka 9–10 (jest-axe + cypress-axe)
4. **i18n:** `?ui_lang=fr` verifierad i HTML

Full skärmläsar-session (NVDA/VoiceOver) rekommenderas fortfarande som manuell stickprov.

## Resultat per område

| Område                | Status              | Evidens                                                                                                                        |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Rösta                 | Pass             | `aria-label` på Agree/Disagree/Pass i DOM; jest-axe Statement; cypress-axe `.statement-card`                                   |
| Statement-form        | Pass             | `label for="comment-textarea"`; `aria-invalid`; jest-axe SurveyForm; cypress-axe `.submit-form`                                |
| E-post                | Pass (kod + axe) | Labels + `role="alert"`/`status` i kod; jest-axe EmailSubscribeForm                                                            |
| Invite                | Pass (kod + axe) | Labels + alert/status i kod; jest-axe InviteCodeSubmissionForm                                                                 |
| Modal (Treevite)      | Pass (kod)       | `role="dialog"`, `aria-modal`, `aria-labelledby`, Escape/fokusfälla i `TreeviteLoginCodeModal` (ej live-trigger denna session) |
| Landmarks             | Pass             | `<main>` i Layout + SSR-HTML                                                                                                   |
| i18n                  | Pass             | `?ui_lang=fr` → "En accord" / "En désaccord" / fransk write-prompt                                                             |
| HTML i översättningar | Pass             | Trasiga `<b>`/`</b>` och orphan `</i>` fixade (en_us + spegling)                                                               |

## Fynd som åtgärdades denna sprint

- Trasiga bold-taggar i help/tip-strängar (`en_us` + ar/bs/es_la/hr/my/ps/sw/vi)
- Orphan `</i>` i bl.a. zh, pt_br, nl, it, da, fy_nl

## Kvar / rekommendation

- [ ] En manuell NVDA-/VoiceOver-runda på röst + statement-submit (stickprov)
- [ ] Live-test av Treevite-modal när invite-flöde är tillgängligt
- [ ] E-post-API returnerar 404 i dev — a11y för fel-live-region fungerar, men produktfelet är utanför a11y-spåret

## Koppling till tidigare PR:er

| PR         | Innehåll                                                |
| ---------- | ------------------------------------------------------- |
| #1         | Labels, live regions, `:focus-visible`, modal, `<main>` |
| #2         | `aria-describedby` / `aria-invalid`, `aria-pressed`     |
| #3         | PCA textalternativ                                      |
| #4         | jest-axe + cypress-axe                                  |
| #5 (denna) | i18n HTML-fix + manuell checklista/resultat             |
