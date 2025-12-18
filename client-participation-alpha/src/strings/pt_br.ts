import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Privacidade"
s.TOS = "Termos de uso"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Esta conversa está fechada."
s.participantHelpWelcomeText =
  "Bem vindo a um novo jeito de discutir - <span style='font-weight: 700;'>opine</span> sobre os comentários das pessoas e <span style='font-weight: 700;'>contribua</span> com o seu."

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "Concordo"
s.disagree = "Discordo"
s.pass = "Passo / Indeciso"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Da criadora"
s.comments_remaining = "faltam {{num_comments}}"
s.x_wrote = "escreveu:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentSent =
  "Comentário Enviado! Outros participantes vão ver seu comentário, podendo concordar ou discordar."
s.submitComment = "Enviar"
s.tipCommentsRandom =
  "Comentários são embaralhados para ser exibidos. Quando escreve um comentário, você não está respondendo diretamente para ninguém."
s.writePrompt = "Inclua seu comentário..."
s.writeCommentHelpText =
  "Se o sua opinião não está representada ainda, <strong>escreva</strong> um comentário!</i>"

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Commentário:"
s.group_123 = "Grupo:"
s.opinionGroups = "Grupos de Opinião"
s.pctAgreedLong = "{{pct}}% de todos que opinaram no comentário {{comment_id}} concordaram."
s.pctAgreedOfGroupLong =
  "{{pct}}% de todos do grupo {{group}} que opinaram no comentário {{comment_id}} concordaram."
s.pctDisagreedLong = "{{pct}}% de todos que opinaram no comentário {{comment_id}} discordaram."
s.pctDisagreedOfGroupLong =
  "{{pct}}% de todos do grupo {{group}} que opinaram no comentário {{comment_id}} discordaram."

// ─────────────────────────────────────────────────────────────
// Topics (Delphi)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Invites (Treevite)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────
s.notificationsAlreadySubscribed = "Você está inscrito para receber atualizações dessa discussão."
s.notificationsGetNotified = "Seja notificado quando mais comentários chegarem:"
s.notificationsEnterEmail =
  "Coloque aqui seu email para ser notificado quando mais comentários chegarem:"
s.notificationsSubscribeButton = "Inscreva-se"

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
