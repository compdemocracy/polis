import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Faragha"
s.TOS = "Sheria na Masharti"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Mazungumzo haya yamekamilika."
s.participantHelpWelcomeText =
  "Karibu kwenye aina mpya ya mazungumzo - <em>pigia kura</em> kauli za watu wengine - itakuwa bora zaidi kura zikiwa nyingi."

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "Kubali"
s.disagree = "Kataa"
s.pass = "Puuza au Sina Uhakika"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Haionyeshi utambulisho"
s.comments_remaining = "{{num_comments}} zimesalia"
s.importantCheckbox = "Muhimu"
s.importantCheckboxDesc =
  "Teua kisanduku hiki ikiwa unaamini kuwa kauli hii ni muhimu hasa kwako au inafaa zaidi katika mazungumzo, bila kujali kura yako. Kuteua kutaipa kauli hii kipaumbele cha juu sana ikilinganishwa na kura zako nyingine kwenye uchanganuzi wa mazungumzo."
s.x_wrote = "ameandika:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorConversationClosed = "Mazungumzo haya yamekamilika. Huwezi kutuma kauli zaidi."
s.commentErrorDuplicate = "Nakala! Kauli hiyo tayari imewekwa."
s.commentSendFailed = "Hitilafu fulani imetokea wakati wa kutuma kauli yako."
s.commentSent =
  "Kauli imetumwa! Ni washiriki wengine pekee ndio wataona kauli yako na kuikubali au kuikataa."
s.helpWriteListIntro = "Je, kauli nzuri inapaswa iweje?"
s.helpWriteListRaisNew = "Mtazamo, hali ulizopitia au tatizo jipya"
s.helpWriteListShort = "Yenye maneno mafupi na yanayoeleweka (isizidi herufi 140)"
s.helpWriteListStandalone = "Wazo linalojitegemea"
s.submitComment = "Tuma"
s.tipCommentsRandom =
  " Kauli zinaonyeshwa kwa unasibu na hazijibu moja kwa moja kauli za watu wengine: <b> unaweka kauli inayojitegemea.<b>"
s.writePrompt = "Eleza mtazamo wako (kauli unayoweka si jibu — tuma kauli inayojitegemea)"
s.writeCommentHelpText =
  "Je, mtazamo au hali ulizopitia hazipo kwenye mazungumzo? Ikiwa ndivyo,</b>waweke </b> kupitia kisanduku kilicho hapa chini — </b>mmoja baada ya mwingine</b>."

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Kauli:"
s.group_123 = "Kikundi:"
s.opinionGroups = "Vikundi vya Maoni"
s.pctAgreedLong = "Asilimia {{pct}} ya watu waliopigia kura kauli ya {{comment_id}} wamekubali."
s.pctAgreedOfGroupLong =
  "Asilimia {{pct}} ya walio kwenye kikundi cha {{group}} waliopigia kura kauli ya {{comment_id}} wamekubali."
s.pctDisagreedLong = "Asilimia {{pct}}% ya watu waliopigia kura kauli ya {{comment_id}} wamekataa"
s.pctDisagreedOfGroupLong =
  "Asilimia {{pct}} ya walio kwenye kikundi cha {{group}} waliopigia kura kauli ya {{comment_id}}wamekataa."

// ─────────────────────────────────────────────────────────────
// Topics (Delphi)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Invites (Treevite)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────
s.notificationsAlreadySubscribed = "Umejisajili ili upate taarifa za mazungumzo haya."
s.notificationsGetNotified = "Pata arifa kunapokuwa na kauli zaidi:"
s.notificationsEnterEmail = "Weka anwani yako ya barua pepe ili uarifiwe kunapokuwa na kauli zaidi:"
s.notificationsSubscribeButton = "Jisajili"

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────
s.showTranslationButton = "Washa tafsiri ya wahusika wengine"
s.hideTranslationButton = "Zima Tafsiri"

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
