// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

// Text on the card

s.participantHelpWelcomeText =
  "مرحبًا بكم في نوع جديد من المحادثات يتم فيها <em>التصويت</em> على ما يكتبه الآخرون، وكلما زاد عدد الأصوات، كان ذلك أفضل.";

s.agree = "أوافق";
s.disagree = "لا أوافق";
s.pass = "التخطي / ليست لديّ إجابة مؤكَّدة";

s.writePrompt ="يُرجى مشاركة وجهة نظرك (ملاحظتك لا تُعدّ ردًا، لذلك قدِّم ملاحظة مستقلة)";
s.anonPerson = "إخفاء الهوية";
s.importantCheckbox = "مهمة/جوهرية";
s.importantCheckboxDesc =
  "يُرجى وضع علامة في هذا المربع إذا كان باعتقادك أنّ هذه العبارة مهمة جدًا لك أو ذات صلة وثيقة بالمحادثة، بغض النظر عن قرار تصويتك. سيؤدي ذلك إلى منح هذه العبارة أولوية أعلى مقارنةً بالعبارات الأخرى التي صوَّت عليها في تحليل المحادثة.";

s.howImportantPrompt = "ما مدى أهمية هذه العبارة؟";
s.howImportantLow = "قليلة الأهمية";
s.howImportantMedium = "متوسطة الأهمية";
s.howImportantHigh = "شديدة الأهمية";

s.modSpam = "غير مرغوب فيها";
s.modOffTopic = "خارج الموضوع";
s.modImportant = "مهمة";
s.modSubmitInitialState = "التخطي (لا شيء من الخيارات السابقة)، العبارة التالية";
s.modSubmit = "تم، العبارة التالية";

s.x_wrote = "كَتبَ:";
s.comments_remaining = "{{num_comments}} متبقّية";
s.comments_remaining2 = "{{num_comments}} عبارة متبقّية";

// Text about phasing

s.noCommentsYet = "ما مِن عبارات إلى الآن.";
s.noCommentsYetSoWrite = "يمكنك بدء هذه المحادثة بإضافة عبارة.";
s.noCommentsYetSoInvite =
  "يمكنك بدء هذه المحادثة بدعوة المزيد من المشاركين، أو إضافة عبارة.";
s.noCommentsYouVotedOnAll = "لقد صوَّت على جميع العبارات.";
s.noCommentsTryWritingOne =
  "يمكنك إضافة معلومة بكتابة عبارتك.";
s.convIsClosed = "تم إغلاق هذه المحادثة.";
s.noMoreVotingAllowed = "لم يعُد التصويت متاحًا.";

// For the visualization below

s.group_123 = "المجموعة:";
s.comment_123 = "العبارة:";
s.majorityOpinion = "رأي الأغلبية";
s.majorityOpinionShort = "الأغلبية";
s.info = "معلومات";


s.helpWhatAmISeeingTitle = "ما الذي يظهر لي؟";
s.helpWhatAmISeeing =
  "تتم الإشارة إليك باستخدام الدائرة الزرقاء ويتم تجميعك مع الأشخاص الذين يشاركونك وجهة النظر نفسها.";
s.heresHowGroupVoted = "إليك نتيجة تصويت المجموعة {{GROUP_NUMBER}} :";
s.one_person = "{{x}} شخص";
s.x_people = "{{x}} شخص";
s.acrossAllPtpts = "على نطاق جميع المشاركين:";
s.xPtptsSawThisComment = " شاهَد هذه العبارة";
s.xOfThoseAgreed = "من أولئك المشاركين وافقوا على ذلك";
s.xOfthoseDisagreed = "من أولئك المشاركين لم يوافقوا على ذلك";
s.opinionGroups = "مجموعات الرأي";
s.topComments = "أهم العبارات";
s.divisiveComments = "عبارات اختلفت حولها الآراء";
s.pctAgreed = "{{pct}}% وافقوا";
s.pctDisagreed = "{{pct}}% لم يوافقوا";
s.pctAgreedLong =
  "{{pct}}% من إجمالي المصوّتين على العبارة {{comment_id}} وافقوا عليها.";
s.pctAgreedOfGroup = "{{pct}}% من المشاركين في المجموعة {{group}} وافقوا على العبارة";
s.pctDisagreedOfGroup = "{{pct}}% من المشاركين في المجموعة {{group}} لم يوافقوا على العبارة";
s.pctDisagreedLong =
  "{{pct}}% من إجمالي المصوّتين على العبارة {{comment_id}} لم يوافقوا عليها.";
s.pctAgreedOfGroupLong =
  "{{pct}}% من المشاركين في المجموعة {{group}} مِمّن صوَّتوا على العبارة {{comment_id}} وافقوا عليها.";
s.pctDisagreedOfGroupLong =
  "{{pct}}% من المشاركين في المجموعة {{group}} مِمّن صوَّتوا على العبارة {{comment_id}} لم يوافقوا عليها.";
s.participantHelpGroupsText =
  "تتم الإشارة إليك باستخدام الدائرة الزرقاء ويتم تجميعك مع الأشخاص الذين يشاركونك وجهة النظر نفسها.";
s.participantHelpGroupsNotYetText =
  "سيظهر العرض المرئي بعد أن يبدأ 7 مشاركين التصويت";
s.helpWhatAreGroupsDetail =
  "<p>يُرجى النقر على مجموعتك أو المجموعات الأخرى لمعرفة آراء المشاركين فيها..</p><p>آراء الأغلبية هي الأكثر تداولاً على نطاق واسع بين المجموعات.</p>";

// Text about writing your own statement

s.helpWhatDoIDoTitle = " ماذا أفعل؟";
s.helpWhatDoIDo =
  `يمكنك التصويت على عبارات الآخرين بالنقر على "أوافق" أو "لا أوافق"، وكتابة عبارة (فكرة واحدة في كل عبارة)، ودعوة أصدقائك إلى المحادثة.`;
s.writeCommentHelpText =
  "ألا تظهر لك في المحادثة وجهات نظرك أو تجاربك؟ إذا كان الأمر كذلك،</b>يُرجى إضافتها </b> في المربّع أدناه، </b>مع مراعاة تضمين فكرة واحدة في كل مرة</b>.";
s.helpWriteListIntro = "ما هو تعريف العبارات الجيدة؟";
s.helpWriteListStandalone = "فكرة مستقلة";
s.helpWriteListRaisNew = "وجهة نظر أو تجربة أو مشكلة جديدة";
s.helpWriteListShort = "أسلوب كتابة واضح وموجَز (140 حرفًا كحدّ أقصى)";
s.tip = "نصائح:";
s.commentWritingTipsHintsHeader = "نصائح لكتابة العبارات";
s.tipCharLimit = "يجب ألا تزيد أحرف العبارة عن {{char_limit}}.";
s.tipCommentsRandom =
  "يتم عرض العبارات بشكل عشوائي، ولا يكون ردّك موجهًا بشكل مباشر إلى عبارات الأشخاص الآخرين، <b> ما يعني أنّك بصدد إضافة عبارة مستقلة.<b>";
s.tipOneIdea =
  "يُرجى الفصل بين العبارات الطويلة التي تتضمن عدة أفكار. سيسهِّل ذلك على الآخرين التصويت على عباراتك.";
s.tipNoQuestions =
  "يجب ألا تكون العبارات على شكل سؤال. فدور المشاركين أن يوافقوا أو لا يوافقوا على عباراتك.";
s.commentTooLongByChars =
  "تجاوزت العبارة الحد الأقصى لعدد الأحرف المسموح به بمقدار {{CHARACTERS_COUNT}} حرف.";
s.submitComment = "إرسال";
s.commentSent =
  "تم إرسال عبارتك، وستظهر للمشاركين الآخرين ليوافقوا أو لا يوافقوا عليها.";

// Error notices

s.commentSendFailed = "حدث خطأ أثناء إرسال عبارتك.";
s.commentSendFailedEmpty =
  "حدث خطأ أثناء إرسال عبارتك، لأنّها فارغة.";
s.commentSendFailedTooLong =
  "حدث خطأ أثناء إرسال عبارتك، لأنّها طويلة جدًا.";
s.commentSendFailedDuplicate =
  "حدث خطأ أثناء إرسال عبارتك، لأنّه سبق إرسال أخرى طبق الأصل منها.";
s.commentErrorDuplicate = "هناك عبارة طبق الأصل من عبارتك سبق إرسالها.";
s.commentErrorConversationClosed =
  "تم إغلاق هذه المحادثة. لا يمكن إرسال المزيد من العبارات.";
s.commentIsEmpty = "العبارة خالية";
s.commentIsTooLong = "العبارة طويلة جدًا";
s.hereIsNextStatement = "تم التصويت. يُرجى الانتقال إلى الأعلى للاطّلاع على العبارة التالية.";

// Text for the third party translation that appears on the cards

s.showTranslationButton = "تفعيل الترجمة الخارجية";
s.hideTranslationButton = "إيقاف الترجمة";
s.thirdPartyTranslationDisclaimer = "الترجمة مقدَّمة من جهة خارجية";

// Text about notifications and subscriptions and embedding

s.notificationsAlreadySubscribed =
  "أنت مشترك في خدمة تلقّى الإشعارات من هذه المحادثة.";
s.notificationsGetNotified = "تلقّي إشعارات عند إضافة مزيد من العبارات:";
s.notificationsEnterEmail =
  "يُرجى إدخال عنوان بريدك الإلكتروني لتلقّي إشعارات عند إضافة مزيد من العبارات:";
s.labelEmail = "البريد الإلكتروني";
s.notificationsSubscribeButton = "اشتراك";
s.notificationsSubscribeErrorAlert = "حدث خطأ أثناء محاولة الاشتراك";

s.addPolisToYourSite =
  "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";

// Footer

s.privacy = "الخصوصية";
s.TOS = "بنود الخدمة";

// Experimental features

s.importantCheckbox = "هذا التعليق مهم";
s.howImportantPrompt = "ما مدى أهمية هذه العبارة؟";
s.howImportantLow = "قليلة الأهمية";
s.howImportantMedium = "متوسطة الأهمية";
s.howImportantHigh = "شديدة الأهمية";
s.tipStarred = "تم وضع علامة عليها على أنّها مهمة.";

s.modSpam = "غير مرغوب فيها";
s.modOffTopic = "خارج الموضوع";
s.modImportant = "مهمة";
s.modSubmitInitialState = "التخطي (لا شيء من الخيارات السابقة)، العبارة التالية";
s.modSubmit = "تم، العبارة التالية";

s.topic_good_01 = "ماذا يجب علينا فعله بشأن غرفة كرة الطاولة؟";
s.topic_good_01_reason =
  "سؤال بإجابة مفتوحة، ويمكن للجميع إبداء آرائهم بشأن الإجابة عنه";
s.topic_good_02 = "ما رأيك في الاقتراح الجديد؟";
s.topic_good_02_reason =
  "سؤال بإجابة مفتوحة، ويمكن للجميع إبداء آرائهم بشأن الإجابة عنه";
s.topic_good_03 = "هل يمكنك ذكر أسباب بُطء الإنتاجية؟";

s.topic_bad_01 = "أعلن الجميع استعدادهم لعملية الإطلاق";
s.topic_bad_01_reason =
  "سيصوِّت أفراد من فرق مختلفة على الردود، ولكن قد لا يكون لديهم المعرفة الكافية للتصويت بثقة.";
s.topic_bad_02 = "ما هي موانع الإطلاق؟";
s.topic_bad_02_reason = "";

module.exports = s;
