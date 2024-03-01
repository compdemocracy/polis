// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};


// for right to left languages
s.direction = "rtl";

// Text on the card

s.participantHelpWelcomeText = " أهلاً بكم في نوع جديد من المحادثات، </em> صوت <em> على إفادات الأشخاص الآخرين";
s.agree = "أوافق";
s.disagree = "لا أوافق";
s.pass = "غير متأكد / تجاوز التصويت";
s.anonPerson = "مجهول";
s.x_wrote = "كتب";
s.comments_remaining = "{{num_comments}} متبقي";

// Text about writing your own statement

s.writeCommentHelpText = "هل تعتقد أن آرائك أو تجربتك غير موجودة في هذه المحادثة؟ إذا كان الأمر كذلك، الرجاء إضافتها";
s.helpWriteListIntro = "ما الذي يجعل الإفادة جيدة؟";
s.helpWriteListStandalone = "فكرة مستقلة بذاتها";
s.helpWriteListRaisNew = "تطرح وجهات نظر أو تجارب أو مشاكل جديدة";
s.helpWriteListShort = "بوضوح وإيجاز(أقل من ١٤٠ حرف)";
s.tipCommentsRandom = ".الرجاء الانتباه، الإفادات تظهر بشكل عشوائي وأنت لا ترد بشكل مباشر على إفادات المشاركين الآخرين";
s.writePrompt = "...شارك وجهة نظرك";
s.submitComment = "أرسل";

// Text about phasing

s.noCommentsYet = "There aren't any statements yet.";
s.noCommentsYetSoWrite = "Get this conversation started by adding a statement.";
s.noCommentsYetSoInvite = "Get this conversation started by inviting more participants, or add a statement.";
s.noCommentsYouVotedOnAll = "You've voted on all the statements.";
s.noCommentsTryWritingOne = "If you have something to add, try writing your own statement.";
s.convIsClosed = "This conversation is closed.";
s.noMoreVotingAllowed = "No further voting is allowed.";

// Error notices

s.commentSendFailed = "حدث خطأ في إرسال إفادتك.";
s.commentSendFailedEmpty = "حدث خطأ في إرسال إفادتك	- 	الإفادة يجب ألا تكون فارغة";
s.commentSendFailedTooLong = "حدث خطأ في إرسال إفادتك	 - 	الإفادة أطول مما يجب";
s.commentSendFailedDuplicate = "حدث خطأ في إرسال إفادتك	 - 	تم إرسال إفادة مطابقة سابقاً";
s.commentErrorDuplicate = "مكرّر! 	هذه الإفادة موجودة سابقاً	.";
s.commentErrorConversationClosed = "تم إغلاق المحادثة	. 	لا يمكن إرسال أي إفادات";
s.commentIsEmpty = "الإفادة فارغة";
s.commentIsTooLong = "الإفادة أطول مما يجب";

// Text about connecting identity

s.connectFacebook = "Connect Facebook";
s.connectTwitter = "Connect Twitter";
s.connectToPostPrompt = "Connect an identity to submit a statement. We will not post to your timeline.";
s.connectToVotePrompt = "Connect an identity to vote. We will not post to your timeline.";
s.socialConnectPrompt = "Optionally connect to see friends and people you follow in the visualization.";
s.connectFbButton = "Connect with Facebook";
s.connectTwButton = "Connect with Twitter";
s.polis_err_reg_fb_verification_email_sent = "Please check your email for a verification link, then return here to continue.";
s.polis_err_reg_fb_verification_noemail_unverified = "Your Facebook account is unverified. Please verify your email address with Facebook, then return here to continue.";

// For the visualization below

s.group_123 = "مجموعة:";
s.comment_123 = "إفادة :";
s.majorityOpinion = "رأي الأغلبية ";
s.majorityOpinionShort = "الأغلبية";
s.info = "معلومات";
s.helpWhatAmISeeingTitle = "ماذا أرى؟ ";
s.helpWhatAmISeeing ="تم وضع الأشخاص المتقاربين في التصويت ضمن مجموعات. اضغط على مجموعة لرؤية وجهة النظر التي يتشاركونها. ";
s.helpWhatDoIDoTitle = "ماذا أفعل؟";
s.helpWhatDoIDo = ".صوت على إفادات الأشخاص الآخرين، اضغط \"موافق\" أو \"غير موافق\". اكتب إفادة (كل إفادة لفكرة واحدة). ادع أصدقاءك للمحادثة";
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
s.participantHelpGroupsText = "People who vote similarly <span style='font-weight: 700;'>are grouped.</span> Click a group to see which viewpoints they share. <a style='font-weight: 700; cursor: pointer; text-decoration: underline' id='helpTextGroupsExpand'>...more</a>";
s.participantHelpGroupsNotYetText = "The visualization will appear once 7 participants have begun voting";
s.helpWhatAreGroupsDetail = "<p>You've probably seen 'recommended products' on Amazon, or 'recommended movies' on Netflix. Each of those services uses statistics to group the user with people who buy and watch similar things, then show them things that those people bought or watched.</p> <p> When a user votes on statements, they are grouped with people who voted like they did! You can see those groups below. Each is made up of people who have similar opinions. There are fascinating insights to discover in each conversation. Go ahead - click a group to see what brought them together and what makes them unique! </p>";

// Text for the third party translation that appears on the cards

s.showTranslationButton = "Activate third-party translation";
s.hideTranslationButton = "Deactivate Translation";
s.thirdPartyTranslationDisclaimer = "Translation provided by a third party";

// Text about notifications and subscriptions and embedding

s.notificationsAlreadySubscribed = "You are subscribed to updates for this conversation.";
s.notificationsGetNotified = "Get notified when more statements arrive:";
s.notificationsEnterEmail = "Enter your email address to get notified when more statements arrive:";
s.labelEmail = "Email";
s.notificationsSubscribeButton = "Subscribe";
s.notificationsSubscribeErrorAlert = "Error subscribing";

s.addPolisToYourSite = "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";

// Footer

s.privacy = "الخصوصية";
s.TOS = "شروط الخدمة"; 
  
module.exports = s;

