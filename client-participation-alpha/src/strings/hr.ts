import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Privatnost"
s.TOS = "Uslovi korištenja usluge"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Razgovor je zatvoren."
s.participantHelpWelcomeText =
  "Dobro došli u novu vrstu razgovora – <em>glasajte</em> o izjavama drugih osoba – što više to bolje."

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "Slažem se"
s.disagree = "Ne slažem se"
s.pass = "Uspješno / nisam siguran/na"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Anonimno"
s.comments_remaining = "preostalo: {{num_comments}}"
s.importantCheckbox = "Važno/značajno"
s.importantCheckboxDesc =
  "Potvrdite ovo polje ako vam je ova izjava posebno važna ili mislite da je veoma relevantna za razgovor, bez obzira na to kako ste glasali. Ovim će se izjavi u analizi razgovora dodijeliti veći prioritet u odnosu na prioritet vaših drugih glasova."
s.x_wrote = "napisao/la je:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorConversationClosed = "Razgovor je zatvoren. Ne mogu se poslati dodatne izjave."
s.commentErrorDuplicate = "Duplikat! Ta izjava već postoji."
s.commentSendFailed = "Došlo je do greške prilikom slanja izjave."
s.commentSent =
  "Izjava je poslana! Vašu izjavu će vidjeti i s njom će se moći složiti ili ne složiti samo drugi učesnici."
s.helpWriteListIntro = "Šta čini dobru izjavu?"
s.helpWriteListRaisNew = "Novi pogled na stvari, iskustvo ili problem"
s.helpWriteListShort = "Jasna i sažeta formulacija (najviše 140 znakova)"
s.helpWriteListStandalone = "Jedna ideja"
s.submitComment = "Pošalji"
s.tipCommentsRandom =
  "Izjave se prikazuju nasumično i ne odgovarate direktno na izjave drugih osoba: <b> dodajete samostalnu izjavu.<b>"
s.writePrompt = "Podijelite mišljenje (ne dajete odgovor, nego samostalnu izjavu)"
s.writeCommentHelpText =
  "Nedostaju li u razgovoru vaši stavovi ili iskustva? Ako nedostaju,</b>dodajte ih </b> u okvir u nastavku — </b>pojedinačno</b>."

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Izjava:"
s.group_123 = "Grupa:"
s.opinionGroups = "Grupe mišljenja"
s.pctAgreedLong = "{{pct}}% ispitanika se slaže, a koji su glasali o izjavi {{comment_id}}."
s.pctAgreedOfGroupLong =
  "{{pct}}% se slaže iz grupe {{group}} koji su glasali o izjavi {{comment_id}}."
s.pctDisagreedLong = "{{pct}}% se ne slaže, a koji su glasali o izjavi {{comment_id}}."
s.pctDisagreedOfGroupLong =
  "{{pct}}% se ne slaže iz grupe {{group}} koji su glasali o izjavi {{comment_id}}."

// ─────────────────────────────────────────────────────────────
// Topics (Delphi)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Invites (Treevite)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────
s.notificationsAlreadySubscribed = "Pretplaćeni ste na novosti o ovom razgovoru."
s.notificationsGetNotified = "Dobijajte obavještenja kada stignu dodatne izjave:"
s.notificationsEnterEmail =
  "Unesite adresu e-pošte da dobijate obavještenja kada stignu dodatne izjave:"
s.notificationsSubscribeButton = "Pretplatite se"

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────
s.showTranslationButton = "Aktiviraj prevod treće strane"
s.hideTranslationButton = "Deaktiviraj prevod"

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
