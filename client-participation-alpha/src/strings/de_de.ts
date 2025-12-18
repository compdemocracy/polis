import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Privatsphäre"
s.TOS = "Nutzungsbedingungen"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Diese Diskussion ist bereits geschlossen."
s.participantHelpWelcomeText =
  "Willkommen zu einer neuen Art der Diskussion - <span style='font-weight: 700;'>stimme</span> über die Standpunkte der anderen TeilnehmerInnen <span style='font-weight: 700;'>ab</span> und <span style='font-weight: 700;'>teilen</span> Sie Ihren eigenen Standpunkt."

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "Ich stimme zu"
s.disagree = "Ich stimme nicht zu"
s.pass = "Weiter / Ich bin mir unsicher"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Anonym"
s.comments_remaining = "{{num_comments}} verbleibend"
s.importantCheckbox = "Dieses Statement ist wichtig"
s.importantCheckboxDesc =
  "Check this box if you believe this statement is especially important to you or is highly relevant to the conversation, irrespective of your vote. It will give this statement higher priority compared to your other votes in the conversation analysis."
s.x_wrote = "hat geschrieben:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorConversationClosed =
  "Diese Diskussion ist beendet. Es können keine weiteren Statements eingereicht werden."
s.commentErrorDuplicate = "Dopplung! Ein identisches Statement besteht bereits."
s.commentSendFailed = "Es gab einen Fehler beim Einreichen deines Statements."
s.commentSent =
  "Statement wurde gesendet! Die anderen TeilnehmerInnen werden benachrichtigt und können über Ihr Statement abstimmen."
s.helpWriteListIntro = "Was macht ein gutes Statement aus?"
s.helpWriteListRaisNew = "Bringen Sie neue Perspektiven, Erfahrungen und Probleme ein"
s.helpWriteListShort = "Knapp und präzise formuliert (maximal 140 Zeichen)"
s.helpWriteListStandalone = "Eine unabhängige Idee"
s.submitComment = "Einreichen"
s.tipCommentsRandom =
  "Statements werden in zufälliger Reihenfolge angezeigt. Ihre Antwort bezieht sich dabei nicht auf eine bestimmte Person."
s.writePrompt = "Teilen Sie Ihre Meinung mit ..."
s.writeCommentHelpText =
  "Wenn Ihre Sichtweise noch nicht vertreten wird, <strong>verfassen</strong> Sie ein Statement!"

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Statement:"
s.group_123 = "Gruppe:"
s.opinionGroups = "Meinungsgruppen"
s.pctAgreedLong =
  "{{pct}}% aller TeilnehmerInnen, die Statement {{comment_id}} bewertet haben, stimmten zu."
s.pctAgreedOfGroupLong =
  "{{pct}}% aller TeilnehmerInnen in Gruppe {{group}}, die Statement {{comment_id}} bewertet haben, stimmten zu."
s.pctDisagreedLong =
  "{{pct}}% aller TeilnehmerInnen, die Statement {{comment_id}} bewertet haben, stimmten nicht zu."
s.pctDisagreedOfGroupLong =
  "{{pct}}% aller TeilnehmerInnen in Gruppe {{group}}, die Statement {{comment_id}} bewertet haben, stimmten nicht zu."

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
  "Sie erhalten eine Benachrichtigung, wenn es Neuigkeiten in dieser Diskussion gibt."
s.notificationsGetNotified = "Erhalten Sie Benachrichtigungen, wenn weitere Statements eingehen:"
s.notificationsEnterEmail =
  "Geben Sie Ihre Email-Adresse ein, um Benachrichtugnen über neue Statements zu erhalten:"
s.notificationsSubscribeButton = "Abonnieren"

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────
s.showTranslationButton = "Übersetzung aktivieren."
s.hideTranslationButton = "Übersetzung ausschalten."

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
