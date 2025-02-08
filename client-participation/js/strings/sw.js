// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

// Text on the card

s.participantHelpWelcomeText = "Karibu katika mtindo mpya wa mazungumzo - <em>piga kura</em> kwa kauli nyengine za watu";

s.agree = "Kubali";
s.disagree = "Kutokubali";
s.pass = "Pita /  Bila uhakika";

s.writePrompt = "Shiriki mtazamo wako...";
s.anonPerson = "Kutojulikana";
s.x_wrote = "aliandika:";
s.x_tweeted = "tweeted:";
s.comments_remaining = "{{num_comments}} imebaki";
s.comments_remaining2 = "{{num_comments}} kauli zilizobaki";

// Text about phasing

s.noCommentsYet = "Hakuna kauli zilizobaki kwa sasa.";
s.noCommentsYetSoWrite = "Pata kuanzisha mazungumzo haya kwa kuongeza kauli.";
s.noCommentsYetSoInvite = "Pata kuanzisha mazungumzo haya kwa kualika washirika zaidi, ama kuongeza kauli.";
s.noCommentsYouVotedOnAll = "Umepiga kura kwa kauli zote.";
s.noCommentsTryWritingOne = "Kama uko na kitu cha kuongeza, Jaribu kuandika kauli zako mwenyewe.";
s.convIsClosed = "Mazungumzo haya yamefungwa.";
s.noMoreVotingAllowed = "Hakuna upigaji kura zaidi unaoruhusiwa.";

// For the visualization below

s.group_123 = "Kundi:";
s.comment_123 = "Kauli:";
s.majorityOpinion = "Maoni ya wengi";
s.majorityOpinionShort = "Wengi";
s.info = "Habari";
s.helpWhatAmISeeingTitle = "Ni nini ninachoona?";
s.helpWhatAmISeeing = "Watu waliopika kura moja ziliwekwa kwa kikundi. Bonyeza kundi moja ili uone mtazamo wanao shiriki pamoja.";
s.heresHowGroupVoted = "Hivi ndivyo kundi {{GROUP_NUMBER}} lilipiga kura:";
s.one_person = "{{x}} mtu";
s.x_people = "{{x}} watu";
s.acrossAllPtpts = "Kupitia washirika wote:";
s.xPtptsSawThisComment = " niliona kauli hii";
s.xOfThoseAgreed = "ya washirika hao walikubaliana";
s.xOfThoseAgreed = "ya washirika hao hawakukubaliana";
s.opinionGroups = "Vikundi vya Maoni";
s.topComments = "Kauli zilizo tiafora";
s.divisiveComments = "Kauli za mgawanyiko";
s.pctAgreed = "{{pct}}% Kubaliana";
s.pctDisagreed = "{{pct}}% Kutokubaliana";
s.pctAgreedLong = "{{pct}}% ya kila mmoja aliepigia kura kauli hii {{comment_id}} Walikubaliana.";
s.pctAgreedOfGroup = "{{pct}}% ya Kundi {{group}} Walikubaliana";
s.pctDisagreedOfGroup = "{{pct}}% ya kundi {{group}} Hawakukubaliana";
s.pctDisagreedLong = "{{pct}}% ya kila mmoja aliepiga kura kwa kauli hii {{comment_id}} Hawakukubaliana.";
s.pctAgreedOfGroupLong = "{{pct}}% ya wale walio kundi {{group}} ambao walipiga kura kwa kauli {{comment_id}} walikubaliana.";
s.pctDisagreedOfGroupLong = "{{pct}}% ya wale walio kundi {{group}} ambao walipiga kura kwa kauli {{comment_id}} hawakukubaliana.";
s.participantHelpGroupsText = "Watu ambao walipiga kura sawa <span style='font-weight: 700;'> walipangwa pamoja.</span> Bonyeza kundi moja ili uone maoni ya walioshiriki. <a style='font-weight: 700; pointer: pointer; text-decoration: underline' id='helpTextGroupsExpand'>...zaidi</a>";
s.participantHelpGroupsNotYetText = "Taswira itatokezea punde tu washirika 7 wataanza kupiga kura";
s.helpWhatAreGroupsDetail = "<p>Pengine umeona 'bidhaa zilizopendekezwa' kwenye Amazon, au 'filamu zilizopendekezwa' kwenye Netflix. Kila ya huduma hizo hutumia takwimu kupanga mtumiaji na wanunuzi na watazamaji vitu sawia, halafu huwaonyesha vitu ambavyo watu hao walinunua au kutazama.</p> <p> Wakati mtumiaji anapopiga kura kwa kauli kadhaa, wanapangwa kundi moja na watu ambao walipiga kura sawa! Unaweza kuona makundi hayo hapa chini. Kila kundi lina watu wenye maoni yanayofanana. Kuna mambo yenye kuvutia ya kujifunza katika kila mazungumzo. Endelea - bonyeza kundi moja ili uone kilichowaleta pamoja na kinachowafanya kuwa wa kipekee! </p>";

// Text about writing your own statement

s.helpWhatDoIDoTitle = " Ni fanye nini?";
s.helpWhatDoIDo = "Piga kura juu ya kauli za watu wengine kwa kubonyeza 'kubali' au 'kutokubali'. Andika kauli (hifadhi wazo moja kwa kila kauli). Waalike marafiki wako kwenye mazungumzo!";
s.writeCommentHelpText = "Je, mtazamo wako au uzoefu wako unakosekana katika mazungumzo? Kama ndio, <b>ziongeze</b> kwenye sanduku ilio chini.";
s.helpWriteListIntro = "Ni nini inafanya kauli ikue nzuri?";
s.helpWriteListStandalone = "Wazo lakujisimamia";
s.helpWriteListRaisNew = "Toa mitazamo mipya, uzoefu au masuala";
s.helpWriteListShort = "Ni wazi & fupi (isiyopita herufi 140)";
s.tip = "Kidokezo:";
s.commentWritingTipsHintsHeader = "Vidokezo vya kuandika kauli";
s.tipCharLimit = "Kauli zinadhibitiwa kunzia herufi {{char_limit}}.";
s.tipCommentsRandom = "Tafadhali kumbuka, kauli zaonyeshwa kwa bila mpango maalumu na hujibu moja kwa moja kwa kauli za washirika wengine.";
s.tipOneIdea = "Kata sentensi ndefu zenye mawazo mengi. Hii inafanya iwe rahisi kwa wengine kupiga kura juu ya kauli yako.";
s.tipNoQuestions = "Kauli hazipaswi kukuwa katika namna ya swali. Washirika watakubaliana au kutokubaliana na kauli unazotoa.";
s.commentTooLongByChars = "Kikomo cha urefu wa kauli umezidi na herufi {{CHARACTERS_COUNT}}.";
s.submitComment = "Wasilisha";
s.commentSent = "Kauli imewasilishwa! Washirika wengine tu ndio wataona kauli yako na kukubali au kutokubali.";

// Error notices

s.commentSendFailed = "Kulikuwa na hitilafu kuwasilisha kauli yako.";
s.commentSendFailedEmpty = "Kulikuwa na hitilafu kuwasilisha kauli yako - Kauli haipaswi kuwa tupu.";
s.commentSendFailedTooLong = "Kulikuwa na hitilafu kuwasilisha kauli yako - Kauli ni ndefu sana.";
s.commentSendFailedDuplicate = "Kulikuwa na hitilafu kuwasilisha kauli yako - Kauli sawa na hii tayari ipo.";
s.commentErrorDuplicate = "Maradufu! Kauli hiyo tayari ipo.";
s.commentErrorConversationClosed = "Mazungumzo haya yamefungwa. Hakuna kauli zaidi zinaweza kuwasilishwa.";
s.commentIsEmpty = "Kauli ni tupu";
s.commentIsTooLong = "Kauli ni ndefu mno";
s.hereIsNextStatement = "Upigaji kura umefanikiwa. Enda juu ili uone kauli ifuatayo.";

// Text about connecting identity

s.connectFacebook = "Uganisha Facebook";
s.connectTwitter = "Unganisha Twitter";
s.connectToPostPrompt = "Unganisha utambulisho ili kuwasilisha kauli. Hatutaituma kwenye orodha ya matukio yako.";
s.connectToVotePrompt = "Unganisha utambulisho ili upige kura. Hatutaituma kwenye orodha ya matukio yako.";
s.socialConnectPrompt = "Ukitaka unganisha ili kuona marafiki na watu unaofuata katika taswira.";
s.connectFbButton = "Unganisha na Facebook";
s.connectTwButton = "Unganisha na Twitter";
s.polis_err_reg_fb_verification_email_sent = "Tafadhali angalia barua pepe yako kwa kiungo cha uthibitisho, Halafu rudi hapa ili uendelee.";
s.polis_err_reg_fb_verification_noemail_unverified = "Akaunti yako ya Facebook haijathibitishwa. Tafadhali thibitisha anwani yako ya barua pepe na Facebook, Halafu rudi hapa ili uendelee.";

// Text for the third party translation that appears on the cards

s.showTranslationButton = "Amilisha tafsiri ya mtu mwingine";
s.hideTranslationButton = "Zima tafsiri";
s.thirdPartyTranslationDisclaimer = "Tafsiri iliyotolewa na mtu mwingine";

// Text about notifications and subscriptions and embedding

s.notificationsAlreadySubscribed = "Umekua mteja wa matukio mapya ya mazungumzo haya.";
s.notificationsGetNotified = "Pata taarifa pindi tu kauli zaidi zitafika:";
s.notificationsEnterEmail = "Weka anwani yako ya barua pepe ili upate taarifa pini tu kauli zaidi zinapofika:";
s.labelEmail = "Barua Pepe";
s.notificationsSubscribeButton = "Jiandikishe";
s.notificationsSubscribeErrorAlert = "Hitilafu ya kujiandikisha";

s.addPolisToYourSite = "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";

// Footer

s.privacy = "Usiri";
s.TOS = "TOS";

// Experimental features

s.importantCheckbox = "Maoni haya ni muhimu";
s.howImportantPrompt = "Ni vipi kauli hii inaumuhimu?";
s.howImportantLow = "Chini";
s.howImportantMedium = "Katikati";
s.howImportantHigh = "Juu";
s.tipStarred = "Weka alama kama muhimu.";

s.modSpam = "Barua taka";
s.modOffTopic = "Nje ya Mada";
s.modImportant = "Muhimu";
s.modSubmitInitialState = "Ruka (hakuna kati ya zilizopo juu), kauli ifuatayo";
s.modSubmit = "Imekwisha, kauli ifuatayo";

s.topic_good_01 = "Tunapaswa kufanya nini kuhusu chumba cha pingpong?";
s.topic_good_01_reason = "liko wazi, mtu yeyote anaweza kuwa na maoni yake juu ya majibu ya swali hili";
s.topic_good_02 = "Una fikra gani kuhusu hilo pendekezo jipya?";
s.topic_good_02_reason = "iko wazi, mtu yeyote anaweza kuwa na maoni yake juu ya majibu ya swali hili";
s.topic_good_03 = "Unaweza fikiria kitu chochote ambacho kinapunguza kasi ya uzalishaji?";

s.topic_bad_01 = "kila mmoja ripoti utayari wako wa uzinduzi";
s.topic_bad_01_reason = "watu kutoka timu mbalimbali watakuwa wanapiga kura juu ya miitikio, lakini huenda wakawa hawana elimu ya kutosha ili kupiga kura kwa kujiamini.";
s.topic_bad_02 = "ni nini vizuizi vyetu vya uzinduzi?";
s.topic_bad_02_reason = "";

// Old unused error message from when Polis was a demo <3

s.notSentSinceDemo = "(si kweli, haya ni maonyesho)";

module.exports = s;


