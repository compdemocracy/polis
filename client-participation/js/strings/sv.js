// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

s.agree = "Instämmer";
s.disagree = "Invänder";
s.pass = "Pass / Osäker";

s.importantCheckbox = "Kommentaren är viktig";
s.howImportantPrompt = "Hur viktigt är detta påstånde?";
s.howImportantLow = "Låg";
s.howImportantMedium = "Medium";
s.howImportantHigh = "Hög";

s.modSpam = "Spam";
s.modOffTopic = "Utanför ämnet";
s.modImportant = "Viktigt";
s.modSubmitInitialState = "Pass (inget av ovanstående), nästa påstående";
s.modSubmit = "Färdig, nästa påstående";

s.x_wrote = "skrev:";
s.x_tweeted = "tweetade:";
s.comments_remaining = "{{num_comments}} kvar";
s.comments_remaining2 = "{{num_comments}} påståenden kvar";
s.group_123 = "Grupp:";
s.comment_123 = "Påstående:";
s.majorityOpinion = "Majoriteten";
s.majorityOpinionShort = "Majoritet";
s.info = "Info";
s.addPolisToYourSite = "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";
s.privacy = "Integritet";
s.TOS = "Villkor för användning";
s.writePrompt = "Dela ditt perspektiv...";
s.anonPerson = "Anonym";
s.helpWhatAmISeeingTitle = "Vad är det jag ser?";
s.helpWhatAmISeeing = "Personer som svarar lika grupperas. Klicka på en grupp för att se vilka åsikter de delar.";
s.helpWhatDoIDoTitle = " Vad ska jag göra?";
s.helpWhatDoIDo = "Svara på andras påståenden genom att klicka på 'instämmer' or 'invänder'. Skriv ett påstående (håll det till en enskild idé). Bjud in dina vänner till samtalet!";
s.writeCommentHelpText = "Om du saknar dina perspektiv eller erfarenheter i samtalet, <b>lägg till</b> dem i textrutan nedan.";
s.helpWriteListIntro = "Hur formulerar du ett bra påstående?";
s.helpWriteListStandalone = "Avgränsad idé";
s.helpWriteListRaisNew = "Lyfter nytt perspektiv, erfarenhet eller utmaning";
s.helpWriteListShort = "Tydligt och kortfattat (max 140 tecken)";
s.heresHowGroupVoted = "Så här svarade Grupp {{GROUP_NUMBER}}:";
s.one_person = "{{x}} person";
s.x_people = "{{x}} personer";
s.acrossAllPtpts = "Tvärs över alla deltagare:";
s.xPtptsSawThisComment = " såg detta påstående";
s.xOfThoseAgreed = "av dessa deltagare instämmer";
s.xOfthoseDisagreed = "av dessa deltagare invänder";
s.opinionGroups = "Opinionsgrupper";
s.topComments = "Populärast påståenden";
s.divisiveComments = "Splittrande påståenden";
s.pctAgreed = "{{pct}}% Instämmer";
s.pctDisagreed = "{{pct}}% Invänder";
s.pctAgreedLong = "{{pct}}% av alla som svarade på påstående {{comment_id}} instämmer.";
s.pctAgreedOfGroup = "{{pct}}% av Grupp {{group}} instämmer";
s.pctDisagreedOfGroup = "{{pct}}% av Grupp {{group}} invänder";
s.pctDisagreedLong = "{{pct}}% av alla som svarade på påstående {{comment_id}} invänder.";
s.pctAgreedOfGroupLong = "{{pct}}% av de i Grupp {{group}} som svarade på påstående {{comment_id}} instämmer.";
s.pctDisagreedOfGroupLong = "{{pct}}% av de i Grupp {{group}} som svarade på påstående {{comment_id}} invänder.";
s.commentSent = "Påstående mottaget! Endast andra deltagare kommer att se dina påståenden och instämma eller invända.";
s.commentSendFailed = "Det uppstod ett fel när ditt påstående skickades.";
s.commentSendFailedEmpty = "Det uppstod ett fel när ditt påstående skickades - Påståendet ska inte vara tomt.";
s.commentSendFailedTooLong = "Det uppstod ett fel när ditt påstående skickades - Påståendet är för långt.";
s.commentSendFailedDuplicate = "Det uppstod ett fel när ditt påstående skickades - Påståendet existerar redan.";
s.commentErrorDuplicate = "Duplikat! Påståendet existerar redan.";
s.commentErrorConversationClosed = "Detta samtal är avslutat. Inga fler påståenden kan skickas in.";
s.commentIsEmpty = "Påståendet är tomt";
s.commentIsTooLong = "Påståendet är för långt";
s.hereIsNextStatement = "Svar mottaget. Navigera uppåt för att se nästa påstående.";

s.connectFacebook = "Koppla Facebook";
s.connectTwitter = "Koppla Twitter";
s.connectToPostPrompt = "Koppla en identitet för att skicka in ett påstående. Vi publicera inget på din tidslinje.";
s.connectToVotePrompt = "Koppla en identitet för att svara på påståendet. Vi publicera inget på din tidslinje.";
s.tip = "Tips:";
s.commentWritingTipsHintsHeader = "Tips för att skriva påståenden";
s.tipCharLimit = "Påståenden får max ha {{char_limit}} tecken.";
s.tipCommentsRandom = "Tänk på att påståenden visas slumpmässigt. Ditt påstående kommer inte att uppfattas som ett direkt svar på ett befintligt påstående.";
s.tipOneIdea = "Dela upp långa påståenden som består av flera idéer. Det gör det lättare för andra att svara på ditt påstående.";
s.tipNoQuestions = "Påståenden ska inte vara ställda som en fråga. Det är meningen att deltagare ska instämma eller invända ditt påstående.";
s.commentTooLongByChars = "Påståendets maxlängd är överskridet med {{CHARACTERS_COUNT}} tecken.";
s.notSentSinceDemo = "(inte på riktigt, detta är en demo)";
s.submitComment = "Skicka";
s.tipStarred = "Markera som viktigt.";
s.participantHelpWelcomeText = "Välkommen till ett nytt typ av samtal - <em>rösta</em> på andras påståenden.";
s.participantHelpGroupsText = "Personer som röstade lika <span style='font-weight: 700;'>grupperas.</span> Klicka på en grupp för att se vilka åsikter de delar. <a style='font-weight: 700; cursor: pointer; text-decoration: underline' id='helpTextGroupsExpand'>...mer</a>";
s.participantHelpGroupsNotYetText = "Visualiseringen visas när 7 deltagare börjat rösta";
s.helpWhatAreGroupsDetail = "<p>Du har förmodligen sett 'rekommenderade produkter' på e-handelssidor, eller 'rekommenderade filmer' på streamingtjänster. Dessa använder statistik för att gruppera personer som köpt eller sett liknande saker för att sedan visa rekommendationer baserat på gruppens beteende.</p> <p> När en deltagare röstar på påståenden grupperas de med andra som röstat lika! Nedan ser du dessa grupper. Varje grupp är baserat på personer som har liknande åsikter. Det finns fascinerande upptäcker i alla samtal. Klicka på en grupp för att se vad som för dem samman och vad som separerar dem! </p>";
s.socialConnectPrompt = "Du kan koppla för att se vänner och personer du följder i visualizeringen.";
s.connectFbButton = "Koppla med Facebook";
s.connectTwButton = "Koppla med Twitter";
s.polis_err_reg_fb_verification_email_sent = "Vänligen, kolla din email efter en verifieringslänk. Kom sedan tillbaka hit för att fortsätta.";
s.polis_err_reg_fb_verification_noemail_unverified = "Ditt Facebook-konto är inte verifierad. Vänligen kontrollera din emailadress med Facebook. Kom sedan tillbaka hit för att fortsätta.";
s.showTranslationButton = "Aktivera tredje-parts-översättning";
s.hideTranslationButton = "Inaktivera översättning";
s.thirdPartyTranslationDisclaimer = "Översättning tillhandahållen av tredje-part";

s.notificationsAlreadySubscribed = "Du följer uppdateringar i detta samtal.";
s.notificationsGetNotified = "Bli notifierad när fler påståenden tillkommer:";
s.notificationsEnterEmail = "Ange din emailadress för att bli notifierad när fler påståenden tillkommer:";
s.labelEmail = "Email";
s.notificationsSubscribeButton = "Följ";
s.notificationsSubscribeErrorAlert = "Fel vid följningen";
s.noCommentsYet = "Det finns inga påståenden än.";
s.noCommentsYetSoWrite = "Påbörja samtalet genom att lägga till ett påstående.";
s.noCommentsYetSoInvite = "Påbörja samtalet genom att bjuda in fler deltagare, eller lägg till ett påstående.";
s.noCommentsYouVotedOnAll = "Du har röstat på alla påståenden.";
s.noCommentsTryWritingOne = "Om du har något att tillägga, prova skriv ett eget påstående.";
s.convIsClosed = "Detta samtal är stängt.";
s.noMoreVotingAllowed = "Det går inte att rösta längre.";


s.topic_good_01 = "Vad ska vi göra med pingisrummet?";
s.topic_good_01_reason = "Öppen fråga, alla kan ha en åsikt i denna fråga";
s.topic_good_02 = "Vad tycker du om det nya förslaget?";
s.topic_good_02_reason = "Öppen fråga, alla kan ha en åsikt i denna fråga";
s.topic_good_03 = "Vad tror du sänker produktiviteten?";

s.topic_bad_01 = "alla ska rapporterar när vi är färdiga att lansera";
s.topic_bad_01_reason = "personer från flera team kommer att rösta på möjliga påståenden men kan ha otillräcklig kunskap för att rösta med säkerhet.";
s.topic_bad_02 = "vad är våra lanseringshinder?";
s.topic_bad_02_reason = "";


module.exports = s;
