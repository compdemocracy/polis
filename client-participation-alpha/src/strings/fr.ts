import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Avis de confidentialité"
s.TOS = "Conditions du service"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Cette conversation est fermée."
s.participantHelpWelcomeText =
  "Bienvenue à un nouveau mode de conversation : <em>votez</em> sur les affirmations des autres participants "

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "En accord"
s.disagree = "En désaccord"
s.pass = "Neutre / Incertain"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Anonyme"
s.comments_remaining = "Il en reste {{num_comments}}"
s.x_wrote = "a écrit :"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorConversationClosed =
  "Cette conversation est fermée. Impossible de publier de nouvelles affirmations."
s.commentErrorDuplicate =
  "Une erreur s’est produite lors de la soumission de votre affirmation – Une affirmation identique existe déjà."
s.commentSendFailed = "Une erreur est survenue. Impossible de publier l’affirmation."
s.commentSent =
  "Énoncé publié! Les autres participants verront votre publication et indiqueront s’ils sont en accord ou en désaccord avec l’affirmation."
s.helpWriteListIntro = "Une bonne affirmation:"
s.helpWriteListRaisNew =
  "présente un nouveau point de vue, de nouvelles expériences ou de nouveaux enjeux;"
s.helpWriteListShort = "est claire et concise (compte au plus 140 caractères)"
s.helpWriteListStandalone = "présente une seule idée;"
s.submitComment = "Publier"
s.tipCommentsRandom =
  "Gardez à l’esprit que les énoncés sont affichés de façon aléatoire et que vous ne répondez pas directement à l’affirmation d’un autre participant."
s.writePrompt = "Faites connaître votre point de vue..."
s.writeCommentHelpText =
  "Vous souhaitez faire connaître votre point de vue ou partager votre expérience dans une conversation? Il vous suffit de <b>les ajouter</b> dans le champ ci-dessous."

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Affirmation :"
s.group_123 = "Groupe :"
s.opinionGroups = "Groupes d’opinion"
s.pctAgreedLong =
  "{{pct}} % des personnes qui ont voté au sujet de l’énoncé {{comment_id}} étaient en accord avec celui-ci."
s.pctAgreedOfGroupLong =
  "{{pct}} % des membres du groupe {{group}} ayant voté au sujet de l’énoncé {{comment_id}} étaient en accord avec celui-ci."
s.pctDisagreedLong =
  "{{pct}} % des personnes qui ont voté au sujet de l’énoncé {{comment_id}} étaient en désaccord avec celui-ci."
s.pctDisagreedOfGroupLong =
  "{{pct}} % des membres du groupe {{group}} ayant voté au sujet de l’affirmation {{comment_id}} étaient en désaccord avec celui-ci."

// ─────────────────────────────────────────────────────────────
// Topics (Delphi)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Invites (Treevite)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────
s.notificationsAlreadySubscribed = "Vous êtes abonné aux mises jour de cette conversation."
s.notificationsGetNotified = "Recevez un avis lorsque de nouvelles affirmations sont publiées :"
s.notificationsEnterEmail =
  "Saisissez votre adresse de courriel pour recevoir un message lorsque de nouvelles affirmations sont publiées :"
s.notificationsSubscribeButton = "M’abonner"

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────
s.showTranslationButton = "Activer la traduction par un tiers"
s.hideTranslationButton = "Désactiver le service de traduction"

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
