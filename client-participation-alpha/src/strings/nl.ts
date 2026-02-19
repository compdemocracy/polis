import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Privacy"
s.TOS = "Servicevoorwaarden"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Dit gesprek is afgesloten."
s.participantHelpWelcomeText =
  "Welkom bij een nieuwe soort discussie - <span style='font-weight: 700.'>stem</span> op de meningen van personen en draag bij tot het gesprek door zelf te reageren."

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "Akkoord"
s.disagree = "Niet akkoord"
s.pass = "Onzeker"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Anoniem"
s.comments_remaining = "{{num_comments}} resterend"
s.x_wrote = "schreef:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorConversationClosed =
  "Deze conversatie is afgesloten. Reageren is niet meer toegestaan."
s.commentErrorDuplicate = "Dubbel! Deze reactie bestaat al."
s.commentSendFailed = "Er was een fout bij het toevoegen van uw reactie."
s.commentSent =
  "Reactie verzonden! Andere deelnemers zullen uw reactie zien en akkoord zijn of niet."
s.helpWriteListIntro = "Wat is een goed voorstel?"
s.helpWriteListRaisNew = "Kaart nieuwe perspectieven, ervaringen of problemen aan"
s.helpWriteListShort = "Duidelijk en beknopt (beperkt tot 140 tekens)"
s.helpWriteListStandalone = "Een idee dat op zichzelf staat"
s.submitComment = "Reageer"
s.tipCommentsRandom = "Reacties zijn willekeurig gesorteerd. U bent op niemand aan het reageren"
s.writePrompt = "Geef uw mening..."
s.writeCommentHelpText =
  "<strong>schrijf</strong> een reactie indien uw mening niet wordt vertegenwoordigd</i>"

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Reactie:"
s.group_123 = "Groep:"
s.opinionGroups = "Opiniegroep"
s.pctAgreedLong = "{{pct}}% van iedereen wie stemden op reactie {{comment_id}} waren akkoord."
s.pctAgreedOfGroupLong =
  "{{pct}}% van de Groep {{group}} wie stemden op reactie {{comment_id}} waren akkoord."
s.pctDisagreedLong = "{{pct}}% van iedereen wie stemden op {{comment_id}} waren niet akkoord."
s.pctDisagreedOfGroupLong =
  "{{pct}}% van de Groep {{group}} wie stemden op reactie {{comment_id}} waren niet akkoord."

// ─────────────────────────────────────────────────────────────
// Topics (Delphi)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Invites (Treevite)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────
s.notificationsAlreadySubscribed = "U bent al geabonneerd voor updates in dit gesprek."
s.notificationsGetNotified = "Wordt op de hoogte gebracht zodra er nieuwe reacties verschijnen:"
s.notificationsEnterEmail =
  "Vul uw emailadres in om op de hoogte gesteld te worden van nieuwe reacties:"
s.notificationsSubscribeButton = "Abonneer"

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────
s.showTranslationButton = "Toon vertalingen"
s.hideTranslationButton = "Verberg vertalingen"

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
