import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Privacidad"
s.TOS = "Términos del Servicio"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Esta conversación está cerrada."
s.participantHelpWelcomeText =
  "Te damos la bienvenida a un nuevo tipo de conversación: <em>vota</em> las afirmaciones de otras personas. Cuantos más votos, mejor."

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "De acuerdo"
s.disagree = "En desacuerdo"
s.pass = "Paso/No lo tengo claro"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Anónimo"
s.comments_remaining = "Quedan {{num_comments}}"
s.importantCheckbox = "Importante/Significativa"
s.importantCheckboxDesc =
  "Marca esta casilla si crees que esta afirmación es especialmente importante para ti o muy relevante para la conversación, independientemente del sentido de tu voto. De esta manera, la afirmación tendrá una mayor prioridad en el análisis de la conversación que otros votos que hayas enviado."
s.x_wrote = "ha escrito:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorConversationClosed =
  "Esta conversación está cerrada. No se pueden enviar más afirmaciones."
s.commentErrorDuplicate = "¡Duplicada! Esa afirmación ya existe."
s.commentSendFailed = "No se ha podido enviar tu afirmación."
s.commentSent =
  "Afirmación enviada. Solo otros participantes verán tu afirmación e indicarán si están de acuerdo o en desacuerdo."
s.helpWriteListIntro = "¿Qué hace que una afirmación se considere buena?"
s.helpWriteListRaisNew = "Plantea una perspectiva, una experiencia o un problema nuevos"
s.helpWriteListShort = "Tiene una redacción clara y concisa (límite de 140 caracteres)"
s.helpWriteListStandalone = "Plantea una idea concreta"
s.submitComment = "Enviar"
s.tipCommentsRandom =
  "Las afirmaciones se muestran en orden aleatorio, así que no son una respuesta directa a las afirmaciones de otras personas, sino <b> una afirmación independiente.<b>"
s.writePrompt =
  "Comparte tu punto de vista (no se trata de una respuesta; debes aportar una afirmación independiente)"
s.writeCommentHelpText =
  "¿Tus perspectivas o experiencias no están recogidas en la conversación? En ese caso,</b> añádelas de una en una </b> en el cuadro de abajo</b></b>."

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Afirmación:"
s.group_123 = "Grupo:"
s.opinionGroups = "Grupos de opinión"
s.pctAgreedLong =
  "El {{pct}} % de todas las personas que votaron la afirmación {{comment_id}} está de acuerdo."
s.pctAgreedOfGroupLong =
  "El {{pct}} % de las personas del grupo {{group}} que votaron la afirmación {{comment_id}} está de acuerdo."
s.pctDisagreedLong =
  "El {{pct}} % de todas las personas que votaron la afirmación {{comment_id}} está en desacuerdo."
s.pctDisagreedOfGroupLong =
  "El {{pct}} % de las personas del grupo {{group}} que votaron la afirmación {{comment_id}} está en desacuerdo."

// ─────────────────────────────────────────────────────────────
// Topics (Delphi)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Invites (Treevite)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────
s.notificationsAlreadySubscribed = "Te has suscrito para recibir novedades sobre esta conversación."
s.notificationsGetNotified = "Recibe notificaciones cuando se publiquen más afirmaciones:"
s.notificationsEnterEmail =
  "Escribe tu dirección de correo para recibir notificaciones cuando se publiquen más afirmaciones:"
s.notificationsSubscribeButton = "Suscribirme"

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────
s.showTranslationButton = "Activar traducción de tercero"
s.hideTranslationButton = "Desactivar traducción"

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
