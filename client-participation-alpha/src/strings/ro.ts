import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Politică de confidențialitate"
s.TOS = "Termeni de utilizare"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Această discuție este închisă"
s.participantHelpWelcomeText =
  "Încearcă o nouă experiență de discuție - <em>vote</em> comentează afirmațiile altor participanți."

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "De acord"
s.disagree = "Nu sunt de acord"
s.pass = "Nu știu / Nu sunt sigur"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Anonim"
s.comments_remaining = "{{num_comments}} rămase"
s.x_wrote = "A scris:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorConversationClosed =
  "Această discuție a fost închisă. Nu mai pot fi trimise afirmații."
s.commentErrorDuplicate = "Această afirmație deja există!"
s.commentSendFailed = "Eroare. Afirmația ta nu a fost trimisă."
s.commentSent =
  "Afirmația a fost trimisă! Doar alți participanți o vor putea vedea și vota de acord sau nu sunt de acord"
s.helpWriteListIntro = "Cum să scrii un comentariu bun?"
s.helpWriteListRaisNew = "Abordează viziuni, experiențe sau probleme noi"
s.helpWriteListShort = "Scrie clar și concis (până la 140 caractere)"
s.helpWriteListStandalone = "Notează o singură idee"
s.submitComment = "Trimite"
s.tipCommentsRandom =
  "Atenție: comentariile sunt afișate în ordine aleatorie. Nu poți răspunde la afirmațiile altor participanți."
s.writePrompt = "Împărtășește-ți viziunea"
s.writeCommentHelpText =
  "Viziunea sau experiența ta lipsește în această discuție? Dacă da <b> scrie ce crezi </b> în câmpul de mai jos."

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Afirmație"
s.group_123 = "Grup:"
s.opinionGroups = "Grupuri de opinii"
s.pctAgreedLong =
  "{{pct}}% din cei care au votat la această afirmație {{comment_id}} au fost de acord."
s.pctAgreedOfGroupLong =
  "{{pct}}%din cei din grupul {{group}} care au votat la afirmația {{comment_id}} au fost de acord."
s.pctDisagreedLong =
  "{{pct}}% din cei care au votat la această afirmație {{comment_id}} nu a fost de acord."
s.pctDisagreedOfGroupLong =
  "{{pct}}%din cei din grupul {{group}} care au votat la afirmația {{comment_id}} nu au fost de acord."

// ─────────────────────────────────────────────────────────────
// Topics (Delphi)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Invites (Treevite)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────
s.notificationsAlreadySubscribed = "Ești abonat la noutăți din această discuție."
s.notificationsGetNotified = "Primește notificări despre noi comentarii"
s.notificationsEnterEmail =
  "Introdu adresa de email pentru a primi notificări despre noi comentarii"
s.notificationsSubscribeButton = "Abonează-te"

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────
s.showTranslationButton = "Activează traducerea terță"
s.hideTranslationButton = "Dezactivează Traducerea"

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
