import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Preifatrwydd"
s.TOS = "TOS"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Mae'r sgwrs hon ar gau."
s.participantHelpWelcomeText =
  "Croeso i fath newydd o sgwrs - <em> pleidleisiwch </em> ar ddatganiadau pobl eraill."

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "Cytuno"
s.disagree = "Anghytuno"
s.pass = "Dim diddordeb / Ansicr"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Anhysbys"
s.comments_remaining = "{{num_comments}} ar ôl"
s.x_wrote = "ysgrifennodd:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorConversationClosed = "Mae'r sgwrs hon ar gau. Ni ellir cyflwyno datganiadau pellach."
s.commentErrorDuplicate = "Dyblygiad! Mae'r datganiad hwnnw eisoes yn bodoli."
s.commentSendFailed = "Roedd gwall wrth gyflwyno'ch datganiad."
s.commentSent =
  "Cyflwynwyd eich datganiad! Dim ond cyfranogwyr eraill fydd yn gweld eich datganiad ac yn cytuno neu'n anghytuno."
s.helpWriteListIntro = "Beth sy'n gwneud datganiad da?"
s.helpWriteListRaisNew = "Codwch safbwyntiau, profiadau neu faterion newydd"
s.helpWriteListShort = "Clir a chryno (wedi'i gyfyngu i 140 nod)"
s.helpWriteListStandalone = "Syniad ar ei ben ei hun"
s.submitComment = "Cyflwyno"
s.tipCommentsRandom =
  "Cofiwch, mae datganiadau yn cael eu harddangos ar hap ac nid ydych yn ymateb yn uniongyrchol i ddatganiadau cyfranwyr eraill."
s.writePrompt = "Rhannwch eich safbwynt ..."
s.writeCommentHelpText =
  "A yw eich safbwyntiau neu'ch profiadau ar goll o'r sgwrs? Os felly, <b> ychwanegwch nhw </b> yn y blwch isod."

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Datganiad:"
s.group_123 = "Grŵp:"
s.opinionGroups = "Grwpiau Barn"
s.pctAgreedLong = "Cytunodd{{pct}}% o bawb sydd wedi pleidleisio ar ddatganiad {{comment_id}}."
s.pctAgreedOfGroupLong =
  "Cytunodd {{pct}}% o'r rheiny yng Nghrŵp {{group}} a bleidleisiodd ar ddatganiad {{comment_id}}."
s.pctDisagreedLong =
  "Anghytunodd {{pct}}% o bawb sydd wedi pleidleisio ar ddatganiad {{comment_id}}."
s.pctDisagreedOfGroupLong =
  "Anghytunodd {{pct}}% o'r rheiny yng Nghrŵp {{group}} a bleidleisiodd ar ddatganiad {{comment_id}}."

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
  "Rydych chi wedi tanysgrifio i dderbyn diweddariadau ar gyfer y sgwrs hon."
s.notificationsGetNotified = "Cewch eich hysbysu pan fydd mwy o ddatganiadau'n cyrraedd:"
s.notificationsEnterEmail =
  "Rhowch eich cyfeiriad e-bost i gael gwybod pan fydd mwy o ddatganiadau'n cyrraedd:"
s.notificationsSubscribeButton = "Tanysgrifwch"

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────
s.showTranslationButton = "Cychwyn cyfieithiad trydydd parti"
s.hideTranslationButton = "Gorffen cyfieithiad"

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
