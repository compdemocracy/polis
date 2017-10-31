// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY. without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>;

var s = {};

s.agree = "Akkoord";
s.disagree = "Niet akkoord";
s.pass = "Pass / onzeke";

s.modSpam = "Spam";
s.modOffTopic = "Off Topic";
s.modImportant = "Belangrijk";
s.modSubmitInitialState = "Overslaan (geen enkel van bovenstaande), volgende reactie";
s.modSubmit = "Klaar, ga naar volgende reactie";

s.x_wrote = "schreef:";
s.x_tweeted = "tweette:";
s.comments_remaining = "{{num_comments}} overblijvend";
s.comments_remaining2 = "{{num_comments}} resterende reacties";
s.group_123 = "Groep:";
s.comment_123 = "Reactie:";
s.majorityOpinion = "Meerderheidsmening";
s.majorityOpinionShort = "Meerderheid";
s.info = "Info";
s.addPolisToYourSite = "<img style='height: 20px. margin: 0px 4px.' src='{{URL}}'/>";
s.privacy = "Privacy";
s.TOS = "Servicevoorwaarden";
s.writePrompt = "Geef uw mening...";
s.anonPerson = "Anoniem";
s.helpWhatAmISeeingTitle = "Wat ben ik aan het bekijken?";
s.helpWhatAmISeeing = "Mensen met een gelijkaardige mening zijn gegroepeerd. Klik op een groep om hun mening te bekijken.";
s.helpWhatDoIDoTitle = "Wat moet ik doen?";
s.helpWhatDoIDo = "Stem op andere reacties door op 'akkoord' of 'niet akkoord' te klikken. Schrijf een reactie (blijf kort en bondig, één idee per lijn). Nodig vrienden uit om deel te nemen aan de discussie!";
s.writeCommentHelpText = "<strong>schrijf</strong> een reactie indien uw mening niet wordt vertegenwoordigd</i>";
s.heresHowGroupVoted = "Groep {{GROUP_NUMBER}} stemde:";
s.one_person = "{{x}} persoon";
s.x_people = "{{x}} personen";
s.acrossAllPtpts = "Van alle ondervraagde personen:";
s.xPtptsSawThisComment = " zag deze reactie";
s.xOfThoseAgreed = "van deze deelnemers zijn akkoord";
s.xOfthoseDisagreed = "van deze deelnemers zijn niet akkoord";
s.opinionGroups = "Opiniegroep";
s.pctAgreed = "{{pct}}% zijn akkoord";
s.pctDisagreed = "{{pct}}% zijn niet akkoord";
s.pctAgreedLong = "{{pct}}% van iedereen wie stemden op reactie {{comment_id}} waren akkoord.";
s.pctAgreedOfGroup = "{{pct}}% van Groep {{group}} waren akkoord";
s.pctDisagreedOfGroup = "{{pct}}% van Groep {{group}} waren niet akkoord";
s.pctDisagreedLong = "{{pct}}% van iedereen wie stemden op {{comment_id}} waren niet akkoord.";
s.pctAgreedOfGroupLong = "{{pct}}% van de Groep {{group}} wie stemden op reactie {{comment_id}} waren akkoord.";
s.pctDisagreedOfGroupLong = "{{pct}}% van de Groep {{group}} wie stemden op reactie {{comment_id}} waren niet akkoord.";
s.commentSent = "Reactie verzonden! Andere deelnemers zullen uw reactie zien en akkoord zijn of niet.";
s.commentSendFailed = "Er was een fout bij het toevoegen van uw reactie.";
s.commentErrorDuplicate = "Dubbel! Deze reactie bestaat al.";
s.commentErrorConversationClosed = "Deze conversatie is afgesloten. Reageren is niet meer toegestaan.";
s.commentIsEmpty = "Reactie is leeg";
s.commentIsTooLong = "Reactie is te lang";

s.connectFacebook = "Verbinden met Facebook";
s.connectTwitter = "Verbinden met Twitter";
s.connectToPostPrompt = "Verbindt om te reageren, we zullen niets publiceren op uw tijdlijn.";
s.connectToVotePrompt = "Verbindt om te stemmen, we zullen niets publiceren op uw tijdlijn.";
s.tip = "Tip:";
s.commentWritingTipsHintsHeader = "Tips om reacties te schrijven";
s.tipCharLimit = "De lengte van reacties zijn beperkt to {{char_limit}} tekens.";
s.tipCommentsRandom = "Reacties zijn willekeurig gesorteerd. U bent op niemand aan het reageren";
s.tipOneIdea = "Splits lange reacties op in verschillende ideeën. Dit maakt het makkelijker voor anderen om te stemmen.";
s.tipNoQuestions = "Probeer vragen in uw reacties te vermijden. Deelnemers zullen vervolgens al dan niet akkoord gaan met uw stelling.";
s.commentTooLongByChars = "De lengte van uw reactie werd met  {{CHARACTERS_COUNT}} karakters overschreden.";
s.notSentSinceDemo = "(niet echt, dit is een demo)";
s.submitComment = "Reageer";
s.tipStarred = "Gemarkeerd als belangrijk.";
s.participantHelpWelcomeText = "Welkom bij een nieuwe soort discussie - <span style='font-weight: 700.'>stem</span> op de meningen van personen en draag bij tot het gesprek door zelf te reageren.";
s.participantHelpGroupsText = "Personen die gelijkaardig stemmen <span style='font-weight: 700.'>worden gegroepeerd.</span> Klik op een groep om te zien welk standpunt zij innemen <a style='font-weight: 700. cursor: pointer. text-decoration: underline' id='helpTextGroupsExpand'>...more</a>";
s.participantHelpGroupsNotYetText = "De visualisatie zal verschijnen zodra er 7 personen zijn begonnen met stemmen";
s.helpWhatAreGroupsDetail = "<p>U hebt allicht al 'aanbevolen artikels' op Amazon, of ‘aanbevolen films' op Netflix. Elk van deze services gebruiken statistieken om u te groeperen in bij personen die dezelfde dingen kopen of bekijken, vervolgend wordt er u getoond wat deze mensen kochten of naar welke film ze keken.</p> <p> Wanneer u een stem uitbrengt op een reactie wordt u vervolgens gegroepeerd met mensen die dezelfde stem uitbrachten! Onderaan kan u deze groepen bekijken. Elk van deze groepen bestaan uit personen met dezelfde opinie. Er zijn fascinerende inzichten de ontdekken elk van deze gesprekken. Wacht niet langer – klik op een groep om te zien wat hun bijeen bracht en wat hun uniek maakt! </p>";
s.socialConnectPrompt = "Verbind optioneel om te zien welke vrienden en andere personen uw volgt in de visualisatie.";
s.connectFbButton = "Verbind met Facebook";
s.connectTwButton = "Verbind met Twitter";
s.polis_err_reg_fb_verification_email_sent = "Gelieve uw mail te controleren voor een verificatie link, kom vervolgens terug op deze pagina.";
s.polis_err_reg_fb_verification_noemail_unverified = "Uw Facebook account is niet geverifieerd. Gelieven eerst uw emailadres te controleren bij Facebook, kom vervolgens terug op deze pagina om verder te gaan.";
s.showTranslationButton = "Toon vertalingen";
s.hideTranslationButton = "Verberg vertalingen";

s.notificationsAlreadySubscribed = "U bent al geabonneerd voor updates in dit gesprek.";
s.notificationsGetNotified = "Wordt op de hoogte gebracht zodra er nieuwe reacties verschijnen:";
s.notificationsEnterEmail = "Vul uw emailadres in om op de hoogte gesteld te worden van nieuwe reacties:";
s.labelEmail = "Email";
s.notificationsSubscribeButton = "Abonneer";
s.noCommentsYet = "Er zijn nog geen reacties beschikbaar.";
s.noCommentsYetSoWrite = "Start dit gesprek door als eerste een reactie toe te voegen.";
s.noCommentsYetSoInvite = "Start dit gesprek door nieuwe deelnemers toe te voegen, of voeg als eerste een reactie toe.";
s.noCommentsYouVotedOnAll = "U hebt op alle reacties gestemd.";
s.noCommentsTryWritingOne = "Als u zelf iets wilt toevoegen aan het gesprek, probeer dan een reactie te schrijven.";
s.convIsClosed = "Dit gesprek is afgesloten.";
s.noMoreVotingAllowed = "Er mag niet meer gestemd worden.";

s.topic_good_01 = "Wat zouden we kunnen doen met de pingpong kamer?";
s.topic_good_01_reason = "vrijblijvend, iedereen kan een opinie of vraag hebben voor deze vraag';
s.topic_good_02 = "Wat denkt u over het nieuwe voorstel?";
s.topic_good_02_reason = "vrijblijvend, iedereen kan een opinie of vraag hebben voor deze vraag";
s.topic_good_03 = "Kan u iets bedenken dat de productiviteit vertraagt?";

s.topic_bad_01 = "iedereen moet rapporteren over hun vorderingen i.v.m. de start";
s.topic_bad_01_reason = "verschillende mensen van verschillende teams zullen reageren op het antwoord, zij zullen echt niet allemaal de kennis hebben om vastbesloten te kunnen stemmen.";
s.topic_bad_02 = "welke factoren remmen onze start af?";
s.topic_bad_02_reason = "";


module.exports = s;

