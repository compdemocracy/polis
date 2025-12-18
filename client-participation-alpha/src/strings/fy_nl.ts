import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Privacy"
s.TOS = "Tsjinstbetingsten"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Dit petear is sletten."
s.participantHelpWelcomeText =
  "Wolkom by de nije manier fan oerlis - <em>stim</em> op reaksjes fan oare minsken."

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "Akkoard"
s.disagree = "Net akkoard"
s.pass = "Oerslaan / Unwis"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Anonym"
s.comments_remaining = "{{num_comments}} oer"
s.x_wrote = "skreau:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorConversationClosed = "Dizze konversaasje is sletten. Reagearje is net mear tastien."
s.commentErrorDuplicate = "Dûbeld! Dizze reaksje bestiet al."
s.commentSendFailed = "Der wie in flater by it tafoegjen fan jo reaksje."
s.commentSent = "Reaksje ferstjoerd! Oare dielnimmers sille jo reaksje sjen en akkoard wêze of net."
s.helpWriteListIntro = "Wat is in goed foarstel?"
s.helpWriteListRaisNew = "Kaart nije perspektiven, ûnderfiningen of problemen oan"
s.helpWriteListShort = "Dúdlik en koart (beheind ta 140 tekens)"
s.helpWriteListStandalone = "In idee dat op himsels stiet"
s.submitComment = "Reagearje"
s.tipCommentsRandom = "Reaksjes binne troch inoar sortearre. Jo binne op net ien oan it reagearjen"
s.writePrompt = "Diel jo miening…"
s.writeCommentHelpText =
  "<strong>skriuw</strong> in reaksje as jo miening net fertsjinwurdige wurdt</i>"

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Reaksje:"
s.group_123 = "Groep:"
s.opinionGroups = "Opiny groepen"
s.pctAgreedLong = "{{pct}}% fan elkenien dy't stimd hawwe op reaksje {{comment_id}} is akkoard."
s.pctAgreedOfGroupLong =
  "{{pct}}% fan de Groep {{group}} dy't stimd hawwe op reaksje {{comment_id}} is akkoard."
s.pctDisagreedLong = "{{pct}}% fan elkenien dy't stimd hawwe op {{comment_id}} is net akkoard."
s.pctDisagreedOfGroupLong =
  "{{pct}}% fan de Groep {{group}} dy't stimd hawwe op reaksje {{comment_id}} is net akkoard."

// ─────────────────────────────────────────────────────────────
// Topics (Delphi)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Invites (Treevite)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────
s.notificationsAlreadySubscribed = "Jo binne al abonnearre foar fernijingen yn dit petear."
s.notificationsGetNotified = "Wurdt op de hichte brocht sa gau as der nije reaksjes ferskine:"
s.notificationsEnterEmail =
  "Folje jo e-mailadres yn om op de hichte steld te wurden fan nije reaksjes:"
s.notificationsSubscribeButton = "Abonnearje"

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────
s.showTranslationButton = "Oersettingen toane"
s.hideTranslationButton = "Oersettingen ferstopje"

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
