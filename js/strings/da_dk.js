// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

s.agree = "Enig";
s.disagree = "Uenig";
s.pass = "Spring over / Usikker";

s.modSpam = "Spam";
s.modOffTopic = "Off topic";
s.modImportant = "Vigtigt";
s.modSubmitInitialState = "Spring over (ingen af ovenstående), næste kommentar";
s.modSubmit = "Færdig, næste kommentar";

s.x_wrote = "skrev:";
s.x_tweeted = "tweetede:";
s.comments_remaining = "{{num_comments}} tilbage";
s.comments_remaining2 = "{{num_comments}} tilbage";
s.group_123 = "Gruppe:";
s.comment_123 = "Kommentar:";
s.majorityOpinion = "Flertallets mening";
s.majorityOpinionShort = "Flertallet";
s.info = "Info";
s.addPolisToYourSite = "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";
s.privacy = "Privatliv";
s.TOS = "Vilkår for brug";
s.writePrompt = "Del dit perspektiv...";
s.anonPerson = "Anonym";
s.helpWhatAmISeeingTitle = "Hvad er det jeg ser?";
s.helpWhatAmISeeing = "Personer der stemmer tilsvarende grupperes. Klik på en gruppe for at se de holdninger de deler.";
s.helpWhatDoIDoTitle = " Hvad skal jeg gøre?";
s.helpWhatDoIDo = "Stem på andres kommentaterer ved at klikke 'enig' eller 'uenig. Skriv en kommentar (hold hver kommentar til én idé). Inviter andre venner til samtalen!";
s.writeCommentHelpText = "Hvis dit perspektiv ikke er repræsenteret, så <strong>skriv</strong> en kommentar!</i>";
s.helpWriteListIntro = "Hvad er en god kommentar?";
s.helpWriteListStandalone = "Enkeltstående idé";
s.helpWriteListRaisNew = "Rejser nye perspektiver, erfaringer eller problemstillinger";
s.helpWriteListShort = "Klar og præcis (begrænset til 140 tegn)";
s.heresHowGroupVoted = "Her er hvordan gruppe {{GROUP_NUMBER}} stemte:";
s.one_person = "{{x}} person";
s.x_people = "{{x}} personer";
s.acrossAllPtpts = "På tværs af alle deltagere:";
s.xPtptsSawThisComment = " så denne kommentar";
s.xOfThoseAgreed = "af disse deltagere var enige";
s.xOfthoseDisagreed = "af disse deltagere var uenige";
s.opinionGroups = "Meningsgrupper";
s.pctAgreed = "{{pct}}% var enige";
s.pctDisagreed = "{{pct}}% var uenige";
s.pctAgreedLong = "{{pct}}% af alle der stemte på kommentaren {{comment_id}} var enige.";
s.pctAgreedOfGroup = "{{pct}}% af gruppe {{group}} var enige";
s.pctDisagreedOfGroup = "{{pct}}% af gruppe {{group}} var uenige";
s.pctDisagreedLong = "{{pct}}% af alle der stemte på kommentaren {{comment_id}} var uenige.";
s.pctAgreedOfGroupLong = "{{pct}}% af gruppen {{group}} som stemte på kommentaren {{comment_id}} var enige.";
s.pctDisagreedOfGroupLong = "{{pct}}% af gruppen {{group}}som stemte på kommentaren {{comment_id}} var uenige.";
s.commentSent = "Kommentar sendt! Andre deltagere kan se din kommentar og være enig eller uenig i den.";
s.commentSendFailed = "Der opstod et problem ved afsendense af kommentaren.";
s.commentSendFailedEmpty = "Der opstod et problem ved afsendense af kommentaren - bør ikke være tom.";
s.commentSendFailedTooLong = "Der opstod et problem ved afsendense af kommentaren - den er for lang.";
s.commentSendFailedDuplicate = "Der opstod et problem ved afsendense af kommentaren - der eksisterer en identisk.";
s.commentErrorDuplicate = "Kopi! Kommentaren eksisterer allerede.";
s.commentErrorConversationClosed = "Denne samtale er lukket. Der kan ikke afgives flere kommentarer.";
s.commentIsEmpty = "Kommentar er tom";
s.commentIsTooLong = "Kommentar er for lang";
s.hereIsNextStatement = "Succes. Naviger op for at se næste kommentar.";

s.connectFacebook = "Forbind Facebook";
s.connectTwitter = "Forbind Twitter";
s.connectToPostPrompt = "Forbind en identitet for at kommentere. Vi poster ikke på din tidslinje.";
s.connectToVotePrompt = "orbind en identitet for at kommentere. Vi poster ikke på din tidslinje.";
s.tip = "Tip:";
s.commentWritingTipsHintsHeader = "Råd til at skrive kommentarer";
s.tipCharLimit = "Kommentarer er begrænset til {{char_limit}} tegn.";
s.tipCommentsRandom = "Kommentarer vises tilfældigt. Du svarer ikke direkte til nogen.";
s.tipOneIdea = "Bryd længere kommentarer op i flere. Det gør det nemmere for andre at stemme på din kommentar.";
s.tipNoQuestions = "Kommentarer bør udtrykke holdninger i stedet for spørgsmål. Deltagere skal enten være enige eller uenige i dine kommentarer.";
s.commentTooLongByChars = "Længde på kommentar overskrider grænsen med {{CHARACTERS_COUNT}} tegn.";
s.notSentSinceDemo = "(not really, this is a demo)";
s.submitComment = "Indsend";
s.tipStarred = "Markeret som vigtig.";
s.participantHelpWelcomeText = "Velkommen til en ny slags samtale - <span style='font-weight: 700;'>stem</span> på personers holdninger og <span style='font-weight: 700;'>bidrag</span> med dine egne.";
s.participantHelpGroupsText = "Personer der stemmer lig hinanden <span style='font-weight: 700;'>grupperes.</span> Klik på en gruppe for at se, hvilke synspunkter de deler <a style='font-weight: 700; cursor: pointer; text-decoration: underline' id='helpTextGroupsExpand'>...mere</a>";
s.participantHelpGroupsNotYetText = "Visualisering kan først ses når 7 deltagere har stemt";
s.helpWhatAreGroupsDetail = "<p>Du har sikkert set 'anbefalede produkter' på Amazon eller 'anbefalede film' på Netflix. Tjenesterne grupperer dig med personer, der køber eller ser lignende ting, så du får anbefalet, hvad de købte eller så.</p> <p> Når du stemmer på en kommentar, bliver du grupperet med personer der stemte ligesom dig. Du kan se grupperne her. Hver gruppe er sammensat af personer med lignende holdninger. Der kan være fascinerende indsigt i dette - gå på opdagelse og se, hvad der gør grupperne unikke. </p>";
s.socialConnectPrompt = "Du kan forbinde for at se venner og personer du følger i visualiseringen.";
s.connectFbButton = "Forbind med Facebook";
s.connectTwButton = "Forbind med Twitter";
s.polis_err_reg_fb_verification_email_sent = "Check din email for et link, så vi kan verificere dig.";
s.polis_err_reg_fb_verification_noemail_unverified = "Din Facebook-konto er ikke verificeret, Verificer den og kom tilbage..";
s.showTranslationButton = "Aktiver oversættelse";
s.hideTranslationButton = "Deaktiver oversættelse";

s.notificationsAlreadySubscribed = "Du abonnerer på opdateringer for denne samtale.";
s.notificationsGetNotified = "Få notifikationer når der kommer flere kommentarer:";
s.notificationsEnterEmail = "Indtast din email og få besked, når der kommer flere kommentarer:";
s.labelEmail = "Email";
s.notificationsSubscribeButton = "Abonner";
s.noCommentsYet = "Der er endnu ingen kommentarer.";
s.noCommentsYetSoWrite = "Start samtalen ved at tilføje en kommentar.";
s.noCommentsYetSoInvite = "Start samtalen ved at inviterer flere deltagere eller tilføj en kommentar.";
s.noCommentsYouVotedOnAll = "Du har stemt på alle kommentarer.";
s.noCommentsTryWritingOne = "Hvis du har noget at tilføje, så prøv at skrive en kommentar.";
s.convIsClosed = "Samtalen er lukket.";
s.noMoreVotingAllowed = "Det er ikke muligt at stemme mere.";


s.topic_good_01 = "Hvad skal vi gøre med bordtennis-rummet?";
s.topic_good_01_reason = "åben samtale, enhver kan have en holdning til svar på dette spørgsmål";
s.topic_good_02 = "Hvad synes du om det nye forslag??";
s.topic_good_02_reason = "åben samtale, enhver kan have en holdning til svar på dette spørgsmål";
s.topic_good_03 = "Kan du komme i tanke om noget, der sænker produktiviteten?";

s.topic_bad_01 = "alle må godt rapportere hvornår vi er klar";
s.topic_bad_01_reason = "personer fra forskellige teams vil stemme på svar, men de har måske ikke nok viden til at stemme.";
s.topic_bad_02 = "hvorfor har vi ikke lanceret endnu?";
s.topic_bad_02_reason = "";


module.exports = s;
