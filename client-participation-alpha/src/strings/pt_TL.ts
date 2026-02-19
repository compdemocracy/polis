import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Privacidade"
s.TOS = "Tipo de Serviço"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Esta conversa está encerrada."

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.disagree = "Discorda"
s.pass = "Passa / Incerteza"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Anônimo"
s.comments_remaining = "{{num_comments}} restante"
s.x_wrote = "escreva:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorDuplicate = "Duplique! Esse comentário já existe."
s.commentSendFailed = "Ocorreu um erro ao sumbeter a sua declaração."
s.commentSent =
  "Declaração submetida! Apenas os outros participantes que vão ver a sua declaração e se vai concordar ou discordar."
s.helpWriteListIntro = "O que é uma boa declaração?"
s.helpWriteListRaisNew = "Levantar as novas perspectivas, experiências ou questões"
s.helpWriteListShort = "Claro e conciso (limitado a 140 caracteres)"
s.helpWriteListStandalone = "Ideia autônoma"
s.writePrompt = "Compartilhe a sua perspetiva.."
s.writeCommentHelpText =
  "As suas perspectivas ou experiências estão a faltar nesta conversa? Se sim, <b> adicione-as </b> na caixa abaixo."

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Declaração:"
s.group_123 = "Grupo:"
s.opinionGroups = "Grupos de Opinião"
s.pctAgreedLong = "{{pct}}% das pessoas que votaram nesta declaração {{comment_id}} concordou."
s.pctAgreedOfGroupLong =
  "{{pct}}% daqueles que estão no grupo {{group}} que votaram na deklarasaun {{comment_id}} concordou."
s.pctDisagreedLong = "{{pct}}% das pessoas que votarem nesta declaração {{comment_id}} discordou."
s.pctDisagreedOfGroupLong =
  "{{pct}}% daqueles que estão no grupo {{group}} que votaram nesta declaração {{comment_id}} discordou."

// ─────────────────────────────────────────────────────────────
// Topics (Delphi)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Invites (Treevite)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
