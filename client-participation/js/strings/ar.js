// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};


// for right to left languages
s.direction = "rtl";

// Text on the card

s.participantHelpWelcomeText = " أهلاً بكم في نوع جديد من النقاشات، </em> صوت <em> على إفادات الأشخاص الآخرين";
s.agree = "أوافق";
s.disagree = "لا أوافق";
s.pass = "غير متأكد / تجاوز التصويت";
s.writePrompt = "...شارك وجهة نظرك";
s.anonPerson = "مجهول";
s.x_wrote = "كتب";
s.comments_remaining = "{{num_comments}} متبقي";

// Text about writing your own statement

s.helpWhatDoIDoTitle = "ما الذي يجب أن أفعله؟";
s.helpWhatDoIDo = " صوّت على الإفادات المطروحة من الناس بالضغط على موافق أو غير موافق. اكتب إفادتك الخاصة (يجب أن تعبّر الإفادة عن فكرة واحدة، إذا كان لديك أكثر من فكرة، فلتكتب أكثر من إفادة). قم بدعوة أصدقائك للمشاركة في النقاش";
s.writeCommentHelpText = "هل تعتقد أن آرائك أو تجربتك غير موجودة في هذا النقاش؟ إذا كان الأمر كذلك، الرجاء إضافتها";
s.helpWriteListIntro = "ما هي معايير الإفادة الجيدة؟";
s.helpWriteListStandalone = "أن تعبّر عن فكرة واحدة مستقلّة بحد ذاتها";
s.helpWriteListRaisNew = "تطرح وجهة نظر أو رأي أو مشكلة جديدة";
s.helpWriteListShort = "أن تكون واضحة ومختصرة(أقل من ١٤٠ حرف)";
s.tip = "Tip:";
s.commentWritingTipsHintsHeader = "نصائح لكتابة إفادة جيّدة";
s.tipCharLimit = "يجب أن تكون الإفادة أقصر من {{char_limit}} حرف";
s.tipCommentsRandom = ".الرجاء الانتباه، الإفادات تظهر بشكل عشوائي وأنت لا ترد بشكل مباشر على إفادات المشاركين الآخرين";
s.tipOneIdea = "يجب أن تعبّر الإفادة عن فكرة واحدة، إذا كان لديك أكثر من فكرة، فلتكتب أكثر من إفادة. وذلك ليتمكن الآخرون من التصويت عليها";
s.tipNoQuestions = "يجب ألا تكون الإفادات بصيغة سؤال. سيصوّت المشاركون بعدها بالموافقة أو الرفض";
s.commentTooLongByChars = "لقد تخطيت الحد الأعلى للأحرف ب {{CHARACTERS_COUNT}} حرف";
s.submitComment = "أرسل";
s.commentSent = "تم تقديم إفادتك! يمكن للمشاركين فقط رؤيتها والتصويت عليها";

// Text about phasing

s.noCommentsYet = "لا يوجد أي إفادات";
s.noCommentsYetSoWrite = "أضف إفادتك هنا ليبدأ النقاش";
s.noCommentsYetSoInvite = "قم بدعوة المزيد من المشاركين لبدأ النقاش، أو قم بإضافة إفادة";
s.noCommentsYouVotedOnAll = "لقد قمت بالتصويت على جميع الإفادات";
s.noCommentsTryWritingOne = "إذا أردت المشاركة بالنقاش، جرّب كتابة إفادتك الخاصة";
s.convIsClosed = "تم إغلاق هذا النقاش";
s.noMoreVotingAllowed = "تم إيقاف التصويت";

// Error notices

s.commentSendFailed = "حدث خطأ في إرسال إفادتك.";
s.commentSendFailedEmpty = "حدث خطأ في إرسال إفادتك	- 	الإفادة يجب ألا تكون فارغة";
s.commentSendFailedTooLong = "حدث خطأ في إرسال إفادتك	 - 	الإفادة أطول مما يجب";
s.commentSendFailedDuplicate = "حدث خطأ في إرسال إفادتك	 - 	تم إرسال إفادة مطابقة سابقاً";
s.commentErrorDuplicate = "مكرّر! 	هذه الإفادة موجودة سابقاً	.";
s.commentErrorConversationClosed = "تم إغلاق النقاش	. 	لا يمكن إرسال أي إفادات";
s.commentIsEmpty = "الإفادة فارغة";
s.commentIsTooLong = "الإفادة أطول مما يجب";

// Text about connecting identity

s.connectFacebook = "اتصل بفيسبوك";
s.connectTwitter = "اتصل بتويتر";
s.connectToPostPrompt = ".قم بالتسجيل لتتمكن من إضافة إفاداتك. لن ننشر أي شيء على جدولك الزمني";
s.connectToVotePrompt = ".قم بالتسجيل لتتمكن من التصويت. لن ننشر أي شيء على جدولك الزمني";
s.socialConnectPrompt = "بإمكانك التسجيل لرؤية أصدقائك ضمن الشكل البياني";
s.connectFbButton = "اتصل عن طريق فيسبوك";
s.connectTwButton = "اتصل عن طريق تويتر";
s.polis_err_reg_fb_verification_email_sent = "الرجاء الذهاب إلى إيميلك والضغط على رابط التحقق، ثم العودة هنا للمتابعة";
s.polis_err_reg_fb_verification_noemail_unverified = "لم يتم التحقق من حساب الفيسبوك الخاص بك، الرجاء التحقق من الإيميل عن طريق الفيسبوك، ثم العودة هنا للمتابعة";

// For the visualization below

s.group_123 = "مجموعة:";
s.comment_123 = "إفادة :";
s.majorityOpinion = "رأي الأغلبية ";
s.majorityOpinionShort = "الأغلبية";
s.info = "معلومات";
s.helpWhatAmISeeingTitle = "ماذا أرى؟ ";
s.helpWhatAmISeeing ="تم وضع الأشخاص المتقاربين في التصويت ضمن مجموعات. اضغط على مجموعة لرؤية وجهة النظر التي يتشاركونها. ";
s.helpWhatDoIDoTitle = "ماذا أفعل؟";
s.helpWhatDoIDo = ".صوت على إفادات الأشخاص الآخرين، اضغط \"موافق\" أو \"غير موافق\". اكتب إفادة (كل إفادة لفكرة واحدة). ادع أصدقاءك للنقاش";
s.heresHowGroupVoted = "المجموعة رقم  {{GROUP_NUMBER}}  صوّتت على الشكل التالي:";
s.one_person = "{{x}} شخص;"
s.x_people = "{{x}} أشخاص";
s.acrossAllPtpts = ":ضمن جميع المشاركين";
s.xPtptsSawThisComment = "شاهدوا هذه الإفادة ";
s.xOfThoseAgreed = "من هؤلاء المشاركين وافقوا";
s.xOfthoseDisagreed = "من هؤلاء المشاركين لم يوافقوا";
s.opinionGroups = "مجموعات الرأي ";
s.topComments = "الإفادات الأولى";
s.divisiveComments = "الإفادات الخلافية";
s.pctAgreed = "{{pct}}% وافق";
s.pctDisagreed = "{{pct}}% لم يوافقوا";
s.pctAgreedLong = "{{pct}}% من جميع المشاركين صوتوا على الإفادة {{comment_id}} وافقوا";
s.pctAgreedOfGroup = "{{pct}}% من مجموعة  {{group}}  وافقوا ";
s.pctDisagreedOfGroup = "{{pct}}% من مجموعة {{group}} لم يوافقوا";
s.pctDisagreedLong = "{{pct}}% من جميع المشاركين صوتوا على الإفادة {{comment_id}} غير موافقين";
s.pctAgreedOfGroupLong = "{{pct}}% من مجموعة {{group}} الذين صوتوا على إفادة {{comment_id}} وافقوا";
s.pctDisagreedOfGroupLong = "{{pct}}% من مجموعة  {{group}} الذين صوتوا على هذه الإفادة  {{comment_id}} وافقوا";
s.participantHelpGroupsText = "تم<span style='font-weight: 700;'> تجميع </span> الأشخاص الذين صوّتوا بشكل متشابه. اضغط على المجموعة للاطلاع على وجهات النظر التي يتشاركونها.<a style='font-weight: 700; cursor: pointer; text-decoration: underline' id='helpTextGroupsExpand'> …المزيد</a>";
s.participantHelpGroupsNotYetText = "سيظهر الشكل البياني بعد أن يقوم ٧ أشخاص بالمشاركة";
s.helpWhatAreGroupsDetail = " <p> ربما شاهدت 'المنتجات الموصى بها' على أمازون، أو 'الأفلام الموصى بها' على نتفليكس. كل من هذه الخدمات تستخدم الإحصائيات لتجميع المستخدم مع أشخاص يشترون ويشاهدون أشياء مشابهة، ثم تعرض لهم أشياء اشتراها أو شاهدها هؤلاء الأشخاص. عندما يصوت المستخدم على الإفادات، يتم تجميعه مع الأشخاص الذين صوتوا كما فعل! يمكنك رؤية تلك المجموعات أدناه. كل واحدة منها تتألف من أشخاص لديهم آراء مشابهة. هناك رؤى مثيرة للاهتمام يمكن اكتشافها في كل نقاش. انقر على مجموعة لرؤية ما جمعهم معًا وما يجعلهم فريدين! </p>";

// Text for the third party translation that appears on the cards

s.showTranslationButton = "قم بتفعيل ترجمة من برنامج خارجي";
s.hideTranslationButton = "إيقاف الترجمة";
s.thirdPartyTranslationDisclaimer = "تمت الترجمة بواسطة برنامج خارجي";

// Text about notifications and subscriptions and embedding

s.notificationsAlreadySubscribed = "تم تسجيلك لتلقي تحديثات حول هذا النقاش";
s.notificationsGetNotified = "قم بإشعاري عند وصول إفادات جديدة:";
s.notificationsEnterEmail = "ادخل ايميلك لتلقّي الإشعارات عندما تصل إفادات جديدة";
s.labelEmail = "ايميل";
s.notificationsSubscribeButton = "سجّل";
s.notificationsSubscribeErrorAlert = "خطأ في التسجيل";

s.addPolisToYourSite = "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";

// Footer

s.privacy = "الخصوصية";
s.TOS = "شروط الخدمة"; 
  
module.exports = s;

