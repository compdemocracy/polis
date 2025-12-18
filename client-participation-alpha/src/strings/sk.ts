import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Súkromie"
s.TOS = "TOS"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Táto konverzácia je uzavretá."
s.participantHelpWelcomeText =
  "Vitajte v novom druhu online diskusie - <em>hlasujte</em> o návrhoch a zdieľajte vaše názory a skúsenosti. Len tak sa priblížime sa ku konsenzu"

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "Súhlasím"
s.disagree = "Nesúhlasím"
s.pass = "Preskočiť"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Anonym"
s.comments_remaining = "{{num_comments}} zostávajúcich"
s.importantCheckbox = "Tento komentár je dôležitý"
s.x_wrote = "napísal/a:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorConversationClosed =
  "Táto diskusia bola uzatvorená. Ďalšie komentáre už nemôžu byť zadané."
s.commentErrorDuplicate = "Duplikát! Tento komentár už existuje."
s.commentSendFailed = "Chyba pri zadaní výroku."
s.commentSent =
  "Komentár úspešne pridaný! Váš názor a to ako ste hlasovali uvidia len ostatní diskutujúci."
s.helpWriteListIntro = "Čo tvorí dobrý komentár?"
s.helpWriteListRaisNew = "Originálna perspektíva, či prehliadaný uhol pohľadu na vec"
s.helpWriteListShort = "Zreteľný návrh a stručné odôvodnenie (maximálne 140 znakov)"
s.helpWriteListStandalone = "Samostatná myšlienka"
s.submitComment = "Zdieľať"
s.tipCommentsRandom =
  "Návrhy sa zobrazujú náhodne. Vaše návrhy sú nezávislými komentármi a nepredstavujú odpoveď na komentáre ostatných diskutujúcich."
s.writePrompt = "Zdieľajte váš názor, či návrh na riešenie..."
s.writeCommentHelpText =
  "Chýbajú vám v diskusii vaše skúsenosti s problémom či návrhy na jeho riešenie? Neváhajte ich <b>zadať</b> do políčka nižšie."

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Výrok:"
s.group_123 = "Skupina:"
s.opinionGroups = "Názorové skupiny"
s.pctAgreedLong = "{{pct}}% zo všetkých hlasujúcich o výroku {{comment_id}} súhlasilo."
s.pctAgreedOfGroupLong =
  "{{pct}}% zo skupiny {{group}}, ktorí hlasovali za výrok {{comment_id}} súhlasilo."
s.pctDisagreedLong = "{{pct}}% zo všetkých hlasujúcich o výroku {{comment_id}} nesúhlasilo."
s.pctDisagreedOfGroupLong =
  "{{pct}}% zo skupiny {{group}}, ktorí hlasovali za výrok {{comment_id}} nesúhlasilo."

// ─────────────────────────────────────────────────────────────
// Topics (Delphi)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Invites (Treevite)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────
s.notificationsAlreadySubscribed =
  "Ste prihlásený/á na odber noviniek a aktualizácií tejto konverzácie."
s.notificationsGetNotified = "Buďte upovedomený/á o nových výrokoch v tejto konverzácií:"
s.notificationsEnterEmail =
  "Zadajte vašu emailovú adresu, aby ste boli upovedomený/á o nových výrokoch v konverzácií:"
s.notificationsSubscribeButton = "Prihlásiť sa na odber"

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────
s.showTranslationButton = "Preložiť"
s.hideTranslationButton = "Deaktivujte preklad"

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
