// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
// Translation credit: Gayathri Venket (Tamil Nadu)
var s = {};

// Text on the card

s.participantHelpWelcomeText =
  "ஒரு புதிய வகை உரையாடலுக்கு வரவேற்கிறோம் - பிறரின் கருத்துகளுக்கு <em>வாக்களியுங்கள்</em>.";

s.agree = "ஏற்கிறேன்";
s.disagree = "மறுக்கிறேன்";
s.pass = "விருப்பமில்லை / தெரியவில்லை";

s.writePrompt = "உங்கள் பார்வையைத் தெரிவியுங்கள்...";
s.anonPerson = "அனாமதேயமானது";
s.x_wrote = "எழுதியது:";
s.comments_remaining = "{{num_comments}} மீதமுள்ளன";
s.comments_remaining2 = "{{num_comments}} கருத்துகள் மீதமுள்ளன";

// Text about phasing

s.noCommentsYet = "இவற்றுக்கான கருத்துகள் இன்னும் பெறப்படவில்லை.";
s.noCommentsYetSoWrite = "ஒரு கருத்தைச் சேர்ப்பதன் மூலம் உரையாடலைத் தொடங்கலாம்.";
s.noCommentsYetSoInvite =
  "கூடுதல் பங்கேற்பாளர்களைச் சேர்ப்பதன் மூலமோ ஒரு கருத்தைச் சேர்ப்பதன்மூலமோ இந்த உரையாடலைப் பெறாலாம்.";
s.noCommentsYouVotedOnAll = "கருத்துகள் அனைத்துக்கும் வாக்களித்துள்ளீர்கள்.";
s.noCommentsTryWritingOne = "ஏதேனும் சேர்க்க விரும்பினால் உங்கள் கருத்தையும் வழங்கலாம்.";
s.convIsClosed = "உரையாடலுக்கான நேரம் முடிவடைந்தது.";
s.noMoreVotingAllowed = "இனி வாக்களிக்க அனுமதி இல்லை.";

// For the visualization below

s.group_123 = "குழு:";
s.comment_123 = "கருத்து:";
s.majorityOpinion = "பெரும்பான்மையான கருத்து";
s.majorityOpinionShort = "பெரும்பான்மை";
s.info = "விவரம்";
s.helpWhatAmISeeingTitle = "நான் என்ன பார்க்கிறேன்?";
s.helpWhatAmISeeing =
  "ஒரே மாதிரியாக வாக்களிப்பவர்கள் குழுவாக்கப்பட்டுள்ளனர். ஒரு குழுவைக் கிளிக் செய்து அவர்களின் கண்ணோட்டத்தை அறிந்துகொள்ளுங்கள்.";
s.heresHowGroupVoted = "குழு {{GROUP_NUMBER}} எப்படி வாக்களித்தது என்பது இங்கே:";
s.one_person = "{{x}} நபர்";
s.x_people = "{{x}} நபர்கள்";
s.acrossAllPtpts = "பங்கேற்பாளர்கள் அனைவருக்கும்:";
s.xPtptsSawThisComment = " இந்த கருத்தைப் பார்த்தனர்";
s.xOfThoseAgreed = "பங்கேற்பாளர்கள் ஏற்றுள்ளனர்";
s.xOfthoseDisagreed = "பங்கேற்பாளர்கள் ஏற்கவில்லை";
s.opinionGroups = "கருத்து தெரிவிக்கும் குழுக்கள்";
s.topComments = "சிறந்த கருத்துகள்";
s.divisiveComments = "மாற்றுக் கருத்துகள்";
s.pctAgreed = "{{pct}}% ஏற்றனர்";
s.pctDisagreed = "{{pct}}% ஏற்கவில்லை";
s.pctAgreedLong = "{{comment_id}} கருத்துக்கு வாக்களித்தவர்களில் {{pct}}% பேர் ஏற்றனர்.";
s.pctAgreedOfGroup = "{{group}} குழுவில் {{pct}}% பேர் ஏற்றனர் ";
s.pctDisagreedOfGroup = "{{group}} குழுவில் {{pct}}% பேர் ஏற்கவில்லை ";
s.pctDisagreedLong = "{{comment_id}} கருத்துக்கு வாக்களித்தவர்களில் {{pct}}% பேர் ஏற்கவில்லை.";
s.pctAgreedOfGroupLong = "{{comment_id}} கருத்துக்கு வாக்களித்த {{group}} குழுவில் உள்ள {{pct}}% பேர் ஏற்றனர்.";
s.pctDisagreedOfGroupLong = "{{comment_id}} கருத்துக்கு வாக்களித்த {{group}} குழுவில் உள்ள {{pct}}% பேர் ஏற்கவில்லை.";
s.participantHelpGroupsText =
  "ஒரே மாதிரியாக வாக்களிப்பவர்கள் <span style='font-weight: 700;'>குழுவாக்கப்பட்டுள்ளனர்.</span> ஒரு குழுவைக் கிளிக் செய்து அவர்களின் கண்ணோட்டத்தை அறிந்துகொள்ளுங்கள்.. <a style='font-weight: 700; cursor: pointer; text-decoration: underline' id='helpTextGroupsExpand'>...மேலும்</a>";
s.participantHelpGroupsNotYetText = "7 பங்கேற்பாளர்கள் வாக்களிக்கத் தொடங்கியவுடன் காட்சிப்படுத்தப்படும்";
s.helpWhatAreGroupsDetail =
  "<p>Amazonஇல் “பரிந்துரைக்கப்படும் தயாரிப்புகள்” அல்லது  Netflixஇல் 'பரிந்துரைக்கப்படும் திரைப்படங்கள்’ போன்றவற்றை நீங்கள் பார்த்திருக்கலாம். ஒரே மாதிரியான விஷயங்களை வாங்கும் மற்றும் பார்க்கும் நபர்களைக் கொண்டப் பயனர்களைக் குழுவாக்குவதற்காக குறிப்பிடத்தக்க புள்ளிவிவரங்களை அந்தச் சேவைகள் ஒவ்வொன்றும் பயன்படுத்துகின்றன. அவ்வாறு குழுவாக்கிய பிறகு அவர்கள் வாங்கிய அல்லது பார்த்த விஷயங்களுடன் பொருந்தும் வேறு விஷயங்களை அவர்களுக்கு பரிந்துரைகளாகக் காண்பிக்கும்.</p> <p> கருத்துகளுக்கு ஒருவர் வாக்களிக்கும்போது, ​​அவரைப் போலவே வாக்களித்தவர்களுடன் சேர்க்கப்பட்டு குழுவாக்கப்படுவார்கள்! அந்த குழுக்களை கீழே காணலாம். ஒவ்வொரு குழுவும் ஒரே மாதிரியான கருத்துக்களைக் கொண்டவர்களால் உருவாக்கப்பட்டது. ஒவ்வொரு உரையாடலிருந்தும் பெறுவதற்கு கவர்ச்சிகரமான புள்ளிவிவரத் தகவல்கள் உள்ளன. ஒரு குழுவைக் கிளிக் செய்து, எது அவர்களை ஒன்றிணைத்தது மற்றும் அவர்களை தனித்துவமாக்கியது என்பதைப் பாருங்கள்! </p>";

// Text about writing your own statement

s.helpWhatDoIDoTitle = "நான் என்ன செய்ய வேண்டும்?";
s.helpWhatDoIDo =
  "'ஏற்கிறேன்' அல்லது 'ஏற்கவில்லை' என்பதைக் கிளிக் செய்வதன் மூலம் மற்றவர்களின் கருத்துகளுக்கு வாக்களிக்கவும். ஒரு கருத்தை எழுதுங்கள் (ஒவ்வொன்றையும் ஒரு யோசித்து வைத்திருங்கள்). உங்கள் நண்பர்களை உரையாட அழையுங்கள்!";
s.writeCommentHelpText =
  "உரையாடலில் நீங்கள் முன்வைத்த சிந்தனைகள் அல்லது அனுபவங்கள் விடுபட்டதா? அப்படியானால், அவற்றைக் கீழே உள்ள பெட்டியில் <b>சேர்க்கவும்</b>.";
s.helpWriteListIntro = "ஒரு நல்ல கருத்தை எது உருவாக்கும்?";
s.helpWriteListStandalone = "தனித்துவமான யோசனை";
s.helpWriteListRaisNew = "புதிய பார்வைகள், அனுபவங்கள் அல்லது சிக்கல்களைப் பற்றி பேசுங்கள்";
s.helpWriteListShort = "தெளிவாகவும் சுருக்கமாகவும் எழுதுங்கள் (140 எழுத்துகளுக்குள் இருக்கட்டும்)";
s.tip = "உதவிக் குறிப்பு:";
s.commentWritingTipsHintsHeader = "கருத்துகளை வழங்குவதற்கான உதவிக்குறிப்புகள்";
s.tipCharLimit = "கருத்துகளில் {{char_limit}} எழுத்துக்கள் மட்டுமே இருக்க வேண்டும்.";
s.tipCommentsRandom =
  "கருத்துக்கள் சீரற்ற முறையில் காட்டப்படும், மேலும் நீங்கள் பிற பங்கேற்பாளர்களின் கருத்துகளுக்கு நேரடியாக பதிலளிக்கக்கூடாது என்பதை நினைவில்கொள்ளவும்.";
s.tipOneIdea =
  "பல்வேறு யோசனைகள் கொண்ட நீளமான கருத்துக்களைச் சிறு சிறு பகுதிகளாகப் பிரிக்கவும். இது உங்கள் கருத்துகளுக்கு பிறர் வாக்களிக்க ஏற்றதாக இருக்கும்.";
s.tipNoQuestions =
  "கருத்துகளைக் கேள்வி வடிவில் வழங்கக்கூடாது. பங்கேற்பாளர்கள் அவற்றை ஏற்கலாம் அல்லது மறுக்கலாம் என்பது போன்று எளிமையாக இருக்க வேண்டும்.";
s.commentTooLongByChars = "கருத்துகளின் நீளம் {{CHARACTERS_COUNT}} எழுத்துகளுக்கு மிகாமல் இருக்க வேண்டும்.";
s.submitComment = "சமர்ப்பி";
s.commentSent =
  "கருத்து சமர்ப்பிக்கப்பட்டது! உங்கள் கருத்தை பிற பங்கேற்பாளர்கள் மட்டுமே பார்க்க முடியும். மேலும் அதை அவர்கள் ஏற்கலாம் அல்லது மறுக்கலாம்.";

// Error notices

s.commentSendFailed = "உங்கள் கருத்தைச் சமர்ப்பிக்கும்போது பிழை ஏற்பட்டது.";
s.commentSendFailedEmpty =
  "உங்கள் கருத்தைச் சமர்ப்பிக்கும்போது பிழை ஏற்பட்டது - கருத்துப் பெட்டி வெறுமையாக இருக்கக்கூடாது.";
s.commentSendFailedTooLong = "உங்கள் கருத்தைச் சமர்ப்பிக்கும்போது பிழை ஏற்பட்டது - கருத்து மிக நீளமாக உள்ளது.";
s.commentSendFailedDuplicate =
  "உங்கள் கருத்தைச் சமர்ப்பிக்கும்போது பிழை ஏற்பட்டது - இதே போன்ற ஒரு கருத்து ஏற்கெனவே உள்ளது.";
s.commentErrorDuplicate = "நகல் கருத்து! இந்தக் கருத்து ஏற்கெனவெ உள்ளது.";
s.commentErrorConversationClosed = "இந்த உரையாடல் மூடப்பட்டது. கூடுதல் கருத்துகளைச் சமர்ப்பிக்க முடியாது.";
s.commentIsEmpty = "கருத்துப் பெட்டி காலியாக உள்ளது";
s.commentIsTooLong = "கருத்து நீளமாக உள்ளது";
s.hereIsNextStatement = "வாக்களிக்கப்பட்டது. அடுத்தக் கருத்தைப் பார்க்க மேலே தொடரவும்.";

// Text for the third party translation that appears on the cards

s.showTranslationButton = "மூன்றாம் தரப்பு மொழிபெயர்ப்பைச் செயல்படுத்து";
s.hideTranslationButton = "மொழிபெயர்ப்பை செயல்படுத்த வேண்டாம்";
s.thirdPartyTranslationDisclaimer = "மூன்றாம் தரப்பினர் வழங்கிய மொழிபெயர்ப்பு";

// Text about notifications and subscriptions and embedding

s.notificationsAlreadySubscribed = "இந்த உரையாடல் குறித்த அறிவிப்புகளைப் பெற நீங்கள் குழுசேர்ந்துள்ளீர்கள்.";
s.notificationsGetNotified = "மேலும் கருத்துகள் சேர்க்கப்படும்போது அறிவிப்பைப் பெறவும்:";
s.notificationsEnterEmail =
  "மேலும் கருத்துகள் சேர்க்கப்படும்போது அறிவிப்பைப் பெற உங்கள் மின்னஞ்சல் முகவரியை உள்ளிடவும்:";
s.labelEmail = "மின்னஞ்சல்l";
s.notificationsSubscribeButton = "குழுசேர்";
s.notificationsSubscribeErrorAlert = "குழுசேர்வதில் பிழை";

s.addPolisToYourSite = "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";

// Footer

s.privacy = "தனியுரிமை";
s.TOS = "TOS";

// Experimental features

s.importantCheckbox = "இந்தக் கருத்து மிகவும் முக்கியம்";
s.howImportantPrompt = "இந்தக் கருத்து எவ்வளவு முக்கியமானது?";
s.howImportantLow = "குறைவான முக்கியத்துவம்";
s.howImportantMedium = "நடுத்தரமான முக்கியத்துவம்";
s.howImportantHigh = "அதிக முக்கியத்துவம்";
s.tipStarred = "முக்கியம் எனக் குறிக்கப்பட்டது.";

s.modSpam = "ஸ்பேம்";
s.modOffTopic = "தலைப்புக்கு ஏற்றதல்ல";
s.modImportant = "முக்கியம்";
s.modSubmitInitialState = "தவிர் (மேற்கண்டவை எதுவுமில்லை), அடுத்தக் கருத்து";
s.modSubmit = "முடிந்தது, அடுத்த கருத்து";

s.topic_good_01 = "பிங்பாங் அறைக்கு நாம் என்ன செய்ய வேண்டும்?";
s.topic_good_01_reason =
  "அனைவருக்கும் பொதுவானது, இந்த கேள்விக்கான பதில்களில் யார் வேண்டுமானாலும் கருத்து தெரிவிக்கலாம்";
s.topic_good_02 = "புதிய திட்டம் பற்றி நீங்கள் என்ன நினைக்கிறீர்கள்?";
s.topic_good_02_reason =
  "அனைவருக்கும் பொதுவானது, இந்த கேள்விக்கான பதில்களில் யார் வேண்டுமானாலும் கருத்து தெரிவிக்கலாம்";
s.topic_good_03 = "உற்பத்தித் திறனைக் குறைக்கும் ஒன்றைப் பற்றி யோசித்துள்ளீர்களா?";

s.topic_bad_01 =
  "உங்கள் வெளியீட்டுத் தயார்நிலையை அனைவரும் தெரிவிக்கின்றனர்/உங்கள் வெளியீட்டுத் தயார்நிலையை அனைவரும் புகாரளிக்கின்றனர்";
s.topic_bad_01_reason =
  "பல்வேறு அணிகளைச் சேர்ந்தவர்கள் பதில்களில் வாக்களிப்பார்கள், ஆனால் நம்பிக்கையுடன் வாக்களிக்க போதுமான அறிவு இல்லாமல் இருக்கலாம்.";
s.topic_bad_02 = "வெளியீட்டைட் தடுப்பவைகள் எவை?";
s.topic_bad_02_reason = "";

// Old unused error message from when Polis was a demo <3

s.notSentSinceDemo = "(இது உண்மையானது அல்ல. விளக்கமளிக்கும் நோக்கத்துக்காக மட்டும்)";

module.exports = s;
