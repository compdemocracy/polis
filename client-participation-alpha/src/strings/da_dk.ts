import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Privatliv"
s.TOS = "Vilkår for brug"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Samtalen er lukket."
s.participantHelpWelcomeText =
  "Velkommen til en ny slags samtale - <span style='font-weight: 700;'>stem</span> på personers holdninger og <span style='font-weight: 700;'>bidrag</span> med dine egne."

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "Enig"
s.disagree = "Uenig"
s.pass = "Spring over / Usikker"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Anonym"
s.comments_remaining = "{{num_comments}} tilbage"
s.x_wrote = "skrev:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorConversationClosed =
  "Denne samtale er lukket. Der kan ikke afgives flere kommentarer."
s.commentErrorDuplicate = "Kopi! Kommentaren eksisterer allerede."
s.commentSendFailed = "Der opstod et problem ved afsendense af kommentaren."
s.commentSent =
  "Kommentar sendt! Andre deltagere kan se din kommentar og være enig eller uenig i den."
s.helpWriteListIntro = "Hvad er en god kommentar?"
s.helpWriteListRaisNew = "Rejser nye perspektiver, erfaringer eller problemstillinger"
s.helpWriteListShort = "Klar og præcis (begrænset til 140 tegn)"
s.helpWriteListStandalone = "Enkeltstående idé"
s.submitComment = "Indsend"
s.tipCommentsRandom = "Kommentarer vises tilfældigt. Du svarer ikke direkte til nogen."
s.writePrompt = "Del dit perspektiv..."
s.writeCommentHelpText =
  "Hvis dit perspektiv ikke er repræsenteret, så <strong>skriv</strong> en kommentar!</i>"

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Kommentar:"
s.group_123 = "Gruppe:"
s.opinionGroups = "Meningsgrupper"
s.pctAgreedLong = "{{pct}}% af alle der stemte på kommentaren {{comment_id}} var enige."
s.pctAgreedOfGroupLong =
  "{{pct}}% af gruppen {{group}} som stemte på kommentaren {{comment_id}} var enige."
s.pctDisagreedLong = "{{pct}}% af alle der stemte på kommentaren {{comment_id}} var uenige."
s.pctDisagreedOfGroupLong =
  "{{pct}}% af gruppen {{group}}som stemte på kommentaren {{comment_id}} var uenige."

// ─────────────────────────────────────────────────────────────
// Topics (Delphi)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Invites (Treevite)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────
s.notificationsAlreadySubscribed = "Du abonnerer på opdateringer for denne samtale."
s.notificationsGetNotified = "Få notifikationer når der kommer flere kommentarer:"
s.notificationsEnterEmail = "Indtast din email og få besked, når der kommer flere kommentarer:"
s.notificationsSubscribeButton = "Abonner"

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────
s.showTranslationButton = "Aktiver oversættelse"
s.hideTranslationButton = "Deaktiver oversættelse"

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
