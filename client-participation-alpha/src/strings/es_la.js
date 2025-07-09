// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

// Text on the card

s.participantHelpWelcomeText =
  "Te damos la bienvenida a un nuevo tipo de conversación: <em>vota</em> las afirmaciones de otras personas. Cuantos más votos, mejor.";

s.agree = "De acuerdo";
s.disagree = "En desacuerdo";
s.pass = "Paso/No lo tengo claro";

s.writePrompt ="Comparte tu punto de vista (no se trata de una respuesta; debes aportar una afirmación independiente)";
s.anonPerson = "Anónimo";
s.importantCheckbox = "Importante/Significativa";
s.importantCheckboxDesc =
  "Marca esta casilla si crees que esta afirmación es especialmente importante para ti o muy relevante para la conversación, independientemente del sentido de tu voto. De esta manera, la afirmación tendrá una mayor prioridad en el análisis de la conversación que otros votos que hayas enviado.";

s.howImportantPrompt = "¿Cuál es la importancia de esta afirmación?";
s.howImportantLow = "Baja";
s.howImportantMedium = "Media";
s.howImportantHigh = "Alta";

s.modSpam = "Spam";
s.modOffTopic = "Sin relación con el tema";
s.modImportant = "Importante";
s.modSubmitInitialState = "Saltar (nada de lo anterior); siguiente afirmación";
s.modSubmit = "Hecho, siguiente afirmación";

s.x_wrote = "ha escrito:";
s.comments_remaining = "Quedan {{num_comments}}";
s.comments_remaining2 = "Quedan {{num_comments}} afirmaciones";

// Text about phasing

s.noCommentsYet = "Aún no hay afirmaciones.";
s.noCommentsYetSoWrite = "Añade una afirmación para iniciar esta conversación.";
s.noCommentsYetSoInvite =
  "Invita a más participantes o añade una afirmación para iniciar esta conversación.";
s.noCommentsYouVotedOnAll = "Has votado todas las afirmaciones.";
s.noCommentsTryWritingOne =
  "Si quieres añadir algo, puedes escribir tu propia afirmación.";
s.convIsClosed = "Esta conversación está cerrada.";
s.noMoreVotingAllowed = "No se permiten más votos.";

// For the visualization below

s.group_123 = "Grupo:";
s.comment_123 = "Afirmación:";
s.majorityOpinion = "Opinión de la mayoría";
s.majorityOpinionShort = "Mayoría";
s.info = "Información";


s.helpWhatAmISeeingTitle = "¿Qué estoy viendo?";
s.helpWhatAmISeeing =
  "El círculo azul representa tu perspectiva y se te ha agrupado con otras personas que la comparten.";
s.heresHowGroupVoted = "Así ha votado el grupo {{GROUP_NUMBER}}:";
s.one_person = "{{x}} persona";
s.x_people = "{{x}} personas";
s.acrossAllPtpts = "De todos los participantes:";
s.xPtptsSawThisComment = " han visto esta afirmación";
s.xOfThoseAgreed = "de esos participantes están de acuerdo";
s.xOfthoseDisagreed = "de esos participantes están en desacuerdo";
s.opinionGroups = "Grupos de opinión";
s.topComments = "Afirmaciones con mayor consenso";
s.divisiveComments = "Afirmaciones polarizadoras";
s.pctAgreed = "{{pct}} % de acuerdo";
s.pctDisagreed = "{{pct}} % en desacuerdo";
s.pctAgreedLong =
  "El {{pct}} % de todas las personas que votaron la afirmación {{comment_id}} está de acuerdo.";
s.pctAgreedOfGroup = "El {{pct}} % del grupo {{group}} está de acuerdo";
s.pctDisagreedOfGroup = "El {{pct}} % del grupo {{group}} está en desacuerdo";
s.pctDisagreedLong =
  "El {{pct}} % de todas las personas que votaron la afirmación {{comment_id}} está en desacuerdo.";
s.pctAgreedOfGroupLong =
  "El {{pct}} % de las personas del grupo {{group}} que votaron la afirmación {{comment_id}} está de acuerdo.";
s.pctDisagreedOfGroupLong =
  "El {{pct}} % de las personas del grupo {{group}} que votaron la afirmación {{comment_id}} está en desacuerdo.";
s.participantHelpGroupsText =
  "El círculo azul representa tu perspectiva y se te ha agrupado con otras personas que la comparten.";
s.participantHelpGroupsNotYetText =
  "La visualización aparecerá cuando 7 participantes hayan empezado a votar";
s.helpWhatAreGroupsDetail =
  "<p>Haz clic en tu grupo o en otros para consultar las opiniones de cada grupo.</p><p>Las opiniones de la mayoría son aquellas que más se comparten entre los diferentes grupos.</p>";

// Text about writing your own statement

s.helpWhatDoIDoTitle = "¿Qué tengo que hacer?";
s.helpWhatDoIDo =
  "Para votar las afirmaciones de otras personas, haz clic en De acuerdo o En desacuerdo. Escribe una afirmación (cada una debe comprender una sola idea). Invita a tus amigos a participar en la conversación.";
s.writeCommentHelpText =
  "¿Tus perspectivas o experiencias no están recogidas en la conversación? En ese caso,</b> añádelas de una en una </b> en el cuadro de abajo</b></b>.";
s.helpWriteListIntro = "¿Qué hace que una afirmación se considere buena?";
s.helpWriteListStandalone = "Plantea una idea concreta";
s.helpWriteListRaisNew = "Plantea una perspectiva, una experiencia o un problema nuevos";
s.helpWriteListShort = "Tiene una redacción clara y concisa (límite de 140 caracteres)";
s.tip = "Consejo:";
s.commentWritingTipsHintsHeader = "Consejos para escribir afirmaciones";
s.tipCharLimit = "Las afirmaciones tienen un límite de {{char_limit}} caracteres.";
s.tipCommentsRandom =
  "Las afirmaciones se muestran en orden aleatorio, así que no son una respuesta directa a las afirmaciones de otras personas, sino <b> una afirmación independiente.<b>";
s.tipOneIdea =
  "Divide las afirmaciones extensas que contengan varias ideas. Así, los demás podrán votar tu afirmación más fácilmente.";
s.tipNoQuestions =
  "Las afirmaciones no deben plantearse como preguntas. Los participantes indicarán si están de acuerdo o en desacuerdo con las afirmaciones que hagas.";
s.commentTooLongByChars =
  "La afirmación supera el límite de extensión por {{CHARACTERS_COUNT}} caracteres.";
s.submitComment = "Enviar";
s.commentSent =
  "Afirmación enviada. Solo otros participantes verán tu afirmación e indicarán si están de acuerdo o en desacuerdo.";

// Error notices

s.commentSendFailed = "No se ha podido enviar tu afirmación.";
s.commentSendFailedEmpty =
  "No se ha podido enviar tu afirmación porque está vacía.";
s.commentSendFailedTooLong =
  "No se ha podido enviar tu afirmación porque es demasiado larga.";
s.commentSendFailedDuplicate =
  "No se ha podido enviar tu afirmación porque ya existe una afirmación idéntica.";
s.commentErrorDuplicate = "¡Duplicada! Esa afirmación ya existe.";
s.commentErrorConversationClosed =
  "Esta conversación está cerrada. No se pueden enviar más afirmaciones.";
s.commentIsEmpty = "La afirmación está vacía";
s.commentIsTooLong = "La afirmación es demasiado larga";
s.hereIsNextStatement = "Voto correcto. Desplázate hacia arriba para ver la siguiente afirmación.";

// Text for the third party translation that appears on the cards

s.showTranslationButton = "Activar traducción de tercero";
s.hideTranslationButton = "Desactivar traducción";
s.thirdPartyTranslationDisclaimer = "Traducción ofrecida por un tercero";

// Text about notifications and subscriptions and embedding

s.notificationsAlreadySubscribed =
  "Te has suscrito para recibir novedades sobre esta conversación.";
s.notificationsGetNotified = "Recibe notificaciones cuando se publiquen más afirmaciones:";
s.notificationsEnterEmail =
  "Escribe tu dirección de correo para recibir notificaciones cuando se publiquen más afirmaciones:";
s.labelEmail = "Correo";
s.notificationsSubscribeButton = "Suscribirme";
s.notificationsSubscribeErrorAlert = "No te has podido suscribir";

s.addPolisToYourSite =
  "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";

// Footer

s.privacy = "Privacidad";
s.TOS = "Términos del Servicio";

// Experimental features

s.importantCheckbox = "Este comentario es importante";
s.howImportantPrompt = "¿Cuál es la importancia de esta afirmación?";
s.howImportantLow = "Baja";
s.howImportantMedium = "Media";
s.howImportantHigh = "Alta";
s.tipStarred = "Marcada como importante.";

s.modSpam = "Spam";
s.modOffTopic = "Sin relación con el tema";
s.modImportant = "Importante";
s.modSubmitInitialState = "Saltar (nada de lo anterior); siguiente afirmación";
s.modSubmit = "Hecho, siguiente afirmación";

s.topic_good_01 = "¿Qué deberíamos hacer con la sala de ping-pong?";
s.topic_good_01_reason =
  "Pregunta abierta, todo el mundo puede dar su opinión sobre las respuestas a esta pregunta";
s.topic_good_02 = "¿Qué piensas de la nueva propuesta?";
s.topic_good_02_reason =
  "Pregunta abierta, todo el mundo puede dar su opinión sobre las respuestas a esta pregunta";
s.topic_good_03 = "¿Se te ocurre algo que esté disminuyendo la productividad?";

s.topic_bad_01 = "Que todo el mundo informe si están listos para el lanzamiento";
s.topic_bad_01_reason =
  "Personas de diferentes equipos votarán las respuestas, pero puede que no tengan el suficiente conocimiento para votar con confianza.";
s.topic_bad_02 = "¿Qué está impidiendo el lanzamiento?";
s.topic_bad_02_reason = "";

export default s;

