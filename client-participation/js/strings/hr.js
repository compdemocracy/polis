var s = {};

// Text on the card

s.participantHelpWelcomeText =
  "Dobro došli u novu vrstu razgovora – <em>glasajte</em> o izjavama drugih osoba – što više to bolje.";

s.agree = "Slažem se";
s.disagree = "Ne slažem se";
s.pass = "Uspješno / nisam siguran/na";

s.writePrompt ="Podijelite mišljenje (ne dajete odgovor, nego samostalnu izjavu)";
s.anonPerson = "Anonimno";
s.importantCheckbox = "Važno/značajno";
s.importantCheckboxDesc =
  "Potvrdite ovo polje ako vam je ova izjava posebno važna ili mislite da je veoma relevantna za razgovor, bez obzira na to kako ste glasali. Ovim će se izjavi u analizi razgovora dodijeliti veći prioritet u odnosu na prioritet vaših drugih glasova.";

s.howImportantPrompt = "Koliko je važna ova izjava?";
s.howImportantLow = "Malo";
s.howImportantMedium = "Srednje";
s.howImportantHigh = "Veoma";

s.modSpam = "Neželjena poruka";
s.modOffTopic = "Van teme";
s.modImportant = "Važno";
s.modSubmitInitialState = "Preskoči (ništa od navedenog); pređi na sljedeću izjavu";
s.modSubmit = "Gotovo; pređi na sljedeću izjavu";

s.x_wrote = "napisao/la je:";
s.comments_remaining = "preostalo: {{num_comments}}";
s.comments_remaining2 = "preostalo izjava: {{num_comments}}";

// Text about phasing

s.noCommentsYet = "Još nema nijedne izjave.";
s.noCommentsYetSoWrite = "Započnite ovaj razgovor dodavanjem izjave.";
s.noCommentsYetSoInvite =
  "Započnite ovaj razgovor pozivanjem više učesnika ili dodajte izjavu.";
s.noCommentsYouVotedOnAll = "Glasali ste o svim izjavama.";
s.noCommentsTryWritingOne =
  "Ako želite nešto dodati, pokušajte napisati vlastitu izjavu.";
s.convIsClosed = "Razgovor je zatvoren.";
s.noMoreVotingAllowed = "Glasanje više nije dozvoljeno.";

// For the visualization below

s.group_123 = "Grupa:";
s.comment_123 = "Izjava:";
s.majorityOpinion = "Većinsko mišljenje";
s.majorityOpinionShort = "Većina";
s.info = "Informacije";


s.helpWhatAmISeeingTitle = "Šta je prikazano?";
s.helpWhatAmISeeing =
  "Vas predstavlja plavi krug i u grupi ste s ostalima koji imaju isto mišljenje.";
s.heresHowGroupVoted = "Evo rezultata glasanja grupe {{GROUP_NUMBER}}:";
s.one_person = "{{x}} osoba";
s.x_people = "{{x}} osoba/e";
s.acrossAllPtpts = "Sveukupno za sve učesnike važi sljedeće:";
s.xPtptsSawThisComment = " vidjelo je ovu izjavu";
s.xOfThoseAgreed = "tih učesnika se slaže";
s.xOfthoseDisagreed = "tih učesnika se ne slaže";
s.opinionGroups = "Grupe mišljenja";
s.topComments = "Najpopularnije izjave";
s.divisiveComments = "Kontroverzne izjave";
s.pctAgreed = "{{pct}}% se slaže";
s.pctDisagreed = "{{pct}}% se ne slaže";
s.pctAgreedLong =
  "{{pct}}% ispitanika se slaže, a koji su glasali o izjavi {{comment_id}}.";
s.pctAgreedOfGroup = "{{pct}}% se slaže iz grupe {{group}}";
s.pctDisagreedOfGroup = "{{pct}}% se ne slaže iz grupe {{group}}";
s.pctDisagreedLong =
  "{{pct}}% se ne slaže, a koji su glasali o izjavi {{comment_id}}.";
s.pctAgreedOfGroupLong =
  "{{pct}}% se slaže iz grupe {{group}} koji su glasali o izjavi {{comment_id}}.";
s.pctDisagreedOfGroupLong =
  "{{pct}}% se ne slaže iz grupe {{group}} koji su glasali o izjavi {{comment_id}}.";
s.participantHelpGroupsText =
  "Vas predstavlja plavi krug i u grupi ste s ostalima koji imaju isto mišljenje.";
s.participantHelpGroupsNotYetText =
  "Vizuelizacija će se prikazati kada 7 učesnika počne glasati";
s.helpWhatAreGroupsDetail =
  "<p>Kliknite na svoju ili druge grupe da istražite mišljenje svake grupe.</p><p>Većinska mišljenja su mišljenja koja su najšire zastupljena na nivou svih grupa.</p>";

// Text about writing your own statement

s.helpWhatDoIDoTitle = " Šta trebam uraditi?";
s.helpWhatDoIDo =
  `Glasajte o izjavama drugih osoba klikom na "Slažem se" ili "Ne slažem se"". Napišite izjavu (neka se svaka izjava odnosi na po jednu ideju). Pozovite prijatelje u razgovor!`;
s.writeCommentHelpText =
  "Nedostaju li u razgovoru vaši stavovi ili iskustva? Ako nedostaju,</b>dodajte ih </b> u okvir u nastavku — </b>pojedinačno</b>.";
s.helpWriteListIntro = "Šta čini dobru izjavu?";
s.helpWriteListStandalone = "Jedna ideja";
s.helpWriteListRaisNew = "Novi pogled na stvari, iskustvo ili problem";
s.helpWriteListShort = "Jasna i sažeta formulacija (najviše 140 znakova)";
s.tip = "Savjet:";
s.commentWritingTipsHintsHeader = "Savjeti za pisanje izjava";
s.tipCharLimit = "Izjave su ograničene na ovoliko znakova: {{char_limit}}.";
s.tipCommentsRandom =
  "Izjave se prikazuju nasumično i ne odgovarate direktno na izjave drugih osoba: <b> dodajete samostalnu izjavu.<b>";
s.tipOneIdea =
  "Podijelite duge izjave u kojima obrađujete više ideja. Ovo drugima olakšava da glasaju o vašoj izjavi.";
s.tipNoQuestions =
  "Izjave ne smiju biti u obliku pitanja. Učesnici će se s vašim izjavama složiti ili neće.";
s.commentTooLongByChars =
  "Ograničenje dužine izjave je premašeno za ovoliko znakova: {{CHARACTERS_COUNT}}.";
s.submitComment = "Pošalji";
s.commentSent =
  "Izjava je poslana! Vašu izjavu će vidjeti i s njom će se moći složiti ili ne složiti samo drugi učesnici.";

// Error notices

s.commentSendFailed = "Došlo je do greške prilikom slanja izjave.";
s.commentSendFailedEmpty =
  "Došlo je do greške prilikom slanja izjave – izjava ne smije biti prazna.";
s.commentSendFailedTooLong =
  "Došlo je do greške prilikom slanja izjave – izjava je preduga.";
s.commentSendFailedDuplicate =
  "Došlo je do greške prilikom slanja izjave – već postoji identična izjava.";
s.commentErrorDuplicate = "Duplikat! Ta izjava već postoji.";
s.commentErrorConversationClosed =
  "Razgovor je zatvoren. Ne mogu se poslati dodatne izjave.";
s.commentIsEmpty = "Izjava je prazna";
s.commentIsTooLong = "Izjava je preduga";
s.hereIsNextStatement = "Glasanje je uspjelo. Idite gore da vidite sljedeću izjavu.";

// Text for the third party translation that appears on the cards

s.showTranslationButton = "Aktiviraj prevod treće strane";
s.hideTranslationButton = "Deaktiviraj prevod";
s.thirdPartyTranslationDisclaimer = "Prevod je poslala treća strana";

// Text about notifications and subscriptions and embedding

s.notificationsAlreadySubscribed =
  "Pretplaćeni ste na novosti o ovom razgovoru.";
s.notificationsGetNotified = "Dobijajte obavještenja kada stignu dodatne izjave:";
s.notificationsEnterEmail =
  "Unesite adresu e-pošte da dobijate obavještenja kada stignu dodatne izjave:";
s.labelEmail = "Adresa e-pošte";
s.notificationsSubscribeButton = "Pretplatite se";
s.notificationsSubscribeErrorAlert = "Došlo je do greške prilikom pretplaćivanja";

s.addPolisToYourSite =
  "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";

// Footer

s.privacy = "Privatnost";
s.TOS = "Uslovi korištenja usluge";

// Experimental features

s.importantCheckbox = "Ovaj komentar je važan";
s.howImportantPrompt = "Koliko je važna ova izjava?";
s.howImportantLow = "Malo";
s.howImportantMedium = "Srednje";
s.howImportantHigh = "Veoma";
s.tipStarred = "Označeno kao važno.";

s.modSpam = "Neželjena poruka";
s.modOffTopic = "Van teme";
s.modImportant = "Važno";
s.modSubmitInitialState = "Preskoči (ništa od navedenog); pređi na sljedeću izjavu";
s.modSubmit = "Gotovo; pređi na sljedeću izjavu";

s.topic_good_01 = "Šta trebamo uraditi u pogledu prostorije za stolni tenis?";
s.topic_good_01_reason =
  "otvoreno; svako može poslati mišljenje o odgovorima na ovo pitanje";
s.topic_good_02 = "Šta mislite o novom prijedlogu?";
s.topic_good_02_reason =
  "otvoreno; svako može poslati mišljenje o odgovorima na ovo pitanje";
s.topic_good_03 = "Imate li ideju u pogledu toga šta usporava produktivnost?";

s.topic_bad_01 = "svi trebate prijaviti svoju spremnost za pokretanje";
s.topic_bad_01_reason =
  "o odgovorima će glasati osobe iz raznih timova, ali možda neće raspolagati dovoljnim znanjem da glasaju informirano.";
s.topic_bad_02 = "šta nas sprečava u pokretanju?";
s.topic_bad_02_reason = "";

module.exports = s;
