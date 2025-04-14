// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

// نوشتار روی کارت

s.participantHelpWelcomeText =
  `به نوع جدید مکالمه خوش آمدید - به عبارت‌های دیگران <em>رأی دهید</em> - هرچه بشتر، بهتر.`

s.agree = `موافق`
s.disagree = `مخالف`
s.pass = `گذشتن / نامطمئن`

s.writePrompt =`دیدگاهتان را هم‌رسانی کنید (پاسخ نمی‌دهید — عبارت مستقلی را ارسال کنید)`
s.anonPerson = `ناشناس`
s.importantCheckbox = `مهم/ قابل‌توجه`
s.importantCheckboxDesc =
  `صرف‌نظر از رأی شما، اگر فکر می‌کنید این عبارت برایتان اهمیت ویژه دارد یا به این مکالمه خیلی ارتباط دارد، این چارگوش را علامت بزنید. به‌این‌ترتیب، درمقایسه با رأی‌های دیگرتان در این مکالمه تحلیلی، به این عبارت اولویت بالاتری می‌دهید.`

s.howImportantPrompt = `این عبارت چقدر اهمیت دارد؟`
s.howImportantLow = `کم`
s.howImportantMedium = `متوسط`
s.howImportantHigh = `زیاد`

s.modSpam = `هرزنامه`
s.modOffTopic = `نامربوط`
s.modImportant = `مهم`
s.modSubmitInitialState = `رد شدن (هیچ‌کدام از موارد بالا)، عبارت بعدی`
s.modSubmit = `انجام شد، عبارت بعدی`

s.x_wrote = `نوشت:`
s.x_tweeted = `توییت کرد:`
s.comments_remaining = `{{num_comments}} باقیمانده است`
s.comments_remaining2 = `{{num_comments}} عبارت باقیمانده است`

// Text about phasing

s.noCommentsYet = `هنوز هیچ عبارتی وجود ندارد.`
s.noCommentsYetSoWrite = `این مکالمه را با افزودن عبارتی شروع کنید.`
s.noCommentsYetSoInvite =
  `این مکالمه را با دعوت کردن از شرکت‌کنندگان بیشتر یا افزودن عبارت شروع کنید.`
s.noCommentsYouVotedOnAll = `به همه عبارت‌ها رأی داده‌اید.`
s.noCommentsTryWritingOne =
  `اگر چیزی برای اضافه کردن دارید، عبارت خودتان را بنویسید.`
s.convIsClosed = `این مکالمه بسته شده است.`
s.noMoreVotingAllowed = `رأی دادن بیشتر مجاز نیست.`

// برای دیداری‌سازی زیر

s.group_123 = `گروه:`
s.comment_123 = `عبارت:`
s.majorityOpinion = `نظر اکثریت`
s.majorityOpinionShort = `اکثریت`
s.info = `اطلاعات`


s.helpWhatAmISeeingTitle = `دارم چه می‌بینم؟`
s.helpWhatAmISeeing =
  `شما با دایره آبی معرفی می‌شوید و با کسانی که دیدگاه‌های مشترکی با شما دارند گروه‌بندی می‌شوید.` 
s.heresHowGroupVoted = `رأی گروه {{GROUP_NUMBER}} این است:`
s.one_person = `{{x}} نفر`
s.x_people = `{{x}} نفر`
s.acrossAllPtpts = `بین همه شرکت‌کنندگان:`
s.xPtptsSawThisComment = ` این عبارت را دیدند`
s.xOfThoseAgreed = `از آن شرکت‌کنندگان موافق هستند`
s.xOfthoseDisagreed = `از آن شرکت‌کنندگان مخالف هستند`
s.opinionGroups = `گروه‌های نظر`
s.topComments = `عبارت‌های برتر`
s.divisiveComments = `عبارت‌های تفرقه‌افکن`
s.pctAgreed = `٪{{pct}} موافقت کردند.`
s.pctAgreed = `٪{{pct}} مخالفت کردند`
s.pctAgreedLong =
  `٪{{pct}} از کسانی که با عبارت {{comment_id}} موافق بودند.`
s.pctAgreedOfGroup = `٪{{pct}} از گروه {{group}} موافقت کردند`
s.pctDisagreedOfGroup = `٪{{pct}}از گروه {{group}} مخالف بودند`
s.pctDisagreedLong =
  `٪{{pct}} از کسانی که به عبارت {{comment_id}} رأی مخالف دادند.`
s.pctAgreedOfGroupLong =
  `٪{{pct}} از افراد در گروه {{group}} که به عبارت {{comment_id}} رأی موافق دادند.`
s.pctDisagreedOfGroupLong =
  `٪{{pct}} از افراد در گروه {{group}} که به عبارت {{comment_id}} رأی مخالف دادند.`
s.participantHelpGroupsText =
  `شما با دایره آبی معرفی می‌شوید و با کسانی که دیدگاه‌های مشترکی با شما دارند گروه‌بندی می‌شوید.` 
s.participantHelpGroupsNotYetText =
  `دیداری‌سازی وقتی نمایش داده می‌شود که ۷ شرکت‌کننده رأی دادن را شروع کرده باشند`
s.helpWhatAreGroupsDetail =
  `<p>روی گروهتان یا دیگران کلیک کنید تا نظرهای هر گروه را کاوش کنید.</p><p>اکثریت نظرها آن‌هایی هستند که به‌صورت گسترده‌ای درسراسر گروه‌ها هم‌رسانی شده‌اند.</p>`

// نوشتار درباره نوشتن عبارت خودتان

s.helpWhatDoIDoTitle = ` چه می‌کنم؟`
s.helpWhatDoIDo = `با کلیک کردن روی «موافق» یا «مخالف»، به عبارت‌های دیگران رأی بدهید. عبارتی بنویسید (در هر عبارت یک ایده بگنجانید). دوستانتان را به این مکالمه دعوت کنید!`
s.writeCommentHelpText =
  `آیا دیدگاه‌ها یا تجربیات شما در این مکالمه جاافتاده است؟ اگر چنین است،</b>آن‌ها را </b> در چارگوش زیر اضافه کنید — </b>هربار یک مورد</b>.`
s.helpWriteListIntro = `چه چیزی عبارت را خوب می‌کند؟` 
s.helpWriteListStandalone = `ایده مستقل`
s.helpWriteListRaisNew = `دیدگاه، تجربه، یا مشکلی جدید`
s.helpWriteListShort = `عبارت‌بندی روشن و دقیق (به ۱۴۰ نویسه محدود باشد)`
s.tip = `نکته:`
s.commentWritingTipsHintsHeader = `نکته‌هایی برای نوشتن عبارت‌ها`
s.tipCharLimit = `عبارت‌ها به {{char_limit}} نویسه محدود هستند.`
s.tipCommentsRandom =
  `عبارت‌ها به‌طور تصادفی نمایش داده می‌شوند و شما مستقیماً به عبارت‌های شرکت‌کنندگان دیگر پاسخ نمی‌دهید: <b> عبارت مستقلی اضافه می‌کنید.<b>`
s.tipOneIdea =
  `عبارت‌های طولانی را که چندین ایده دارند بشکنید. این کار رأی دادن دیگران را به عبارت شما ساده‌تر می‌کند.`
s.tipNoQuestions =
  `عبارت‌ها نباید به‌شکل پرسشی باشند. شرکت‌کنندگان با عبارت‌هایی که نوشته‌اید موافق یا مخالف خواهند بود.`
s.commentTooLongByChars =
  `طول عبارت از محدوده {{CHARACTERS_COUNT}} نویسه فراتر رفته است.`
s.submitComment = `ارسال کردن`.
s.commentSent =
  `عبارت ارسال شد! فقط شرکت‌کنندگان دیگر عبارت شما را می‌بینند و موافقت یا مخالفت خود را نشان می‌دهند.`

// اعلان‌های خطا

s.commentSendFailed = `هنگام ارسال عبارت شما خطایی رخ داد.`
s.commentSendFailedEmpty =
  `هنگام ارسال عبارت شما خطایی رخ داد - عبارت نباید خالی باشد.`
s.commentSendFailedTooLong =
  `هنگام ارسال عبارت شما خطایی رخ داد - عبارت خیلی طولانی است.`
s.commentSendFailedDuplicate =
  `هنگام ارسال عبارت شما خطایی رخ داد - عبارت یکسانی ازقبل وجود دارد.`
s.commentErrorDuplicate = `تکراری! این عبارت ازقبل وجود دارد.`
s.commentErrorConversationClosed =
  `این عبارت بسته شده است. هیچ عبارت دیگری نمی‌تواند ارسال شود.`
s.commentIsEmpty = `عبارت خالی است`
s.commentIsTooLong = `عبارت خیلی طولانی است`
s.hereIsNextStatement = `رأی دادن موفقیت‌آمیز بود. به بالا پیمایش کنید تا عبارت بعدی را ببینید.`

// نوشتار درباره ارتباط دادن هویت

s.connectFacebook = `ارتباط دادن فیس‌بوک`
s.connectTwitter = `ارتباط دادن X`
s.connectToPostPrompt =
  `برای ارسال عبارت، هویتی را ارتباط دهید. در خط زمان شما پست نخواهیم کرد.`
s.connectToVotePrompt =
  `برای رأی دادن، هویتی را ارتباط دهید. در خط زمان شما پست نخواهیم کرد.`
s.socialConnectPrompt =
  `به‌طور اختیاری مرتبط شوید تا دوستان و افرادی را که دنبال می‌کنید در دیداری‌سازی ببینید.`
s.connectFbButton = `با فیس‌بوک مرتبط شوید`
s.connectTwButton = `با X مرتبط شویدr`
s.polis_err_reg_fb_verification_email_sent =
  `برای پیوند درستی‌سنجی لطفاً ایمیلتان را بررسی کنید، سپس برای ادامه دادن به اینجا برگردید.`
s.polis_err_reg_fb_verification_noemail_unverified =
  `حساب فیس‌بوک شما تأیید شده است. لطفاً نشانی ایمیلتان را با فیس‌بوک تأیید کنید، سپس برای ادامه دادن به اینجا برگردید.`

// نوشتار برای ترجمه طرف سوم که در کارت‌ها نمایش داده می‌شود

s.showTranslationButton = `فعال کردن ترجمه طرف سوم`
s.hideTranslationButton = `غیرفعال کردن ترجمه`
s.thirdPartyTranslationDisclaimer = `ترجمه ارائه‌شده توسط طرف سوم`

// نوشتار درباره اعلان‌ها و اشتراک‌ها و جاسازی‌ها

s.notificationsAlreadySubscribed =
  `برای به‌روز شدن درباره این مکالمه مشترک شده‌اید.`
s.notificationsGetNotified = `وقتی عبارت‌های بیشتری می‌رسد، اعلان دریافت کنید:`
s.notificationsEnterEmail =
  `نشانی ایمیلتان را وارد کنید تا وقتی عبارت‌های بیشتری می‌رسد مطلع شوید:`
s.labelEmail = `ایمیل`
s.notificationsSubscribeButton = `مشترک شوید`
s.notificationsSubscribeErrorAlert = `خطای مشترک شدن`

s.addPolisToYourSite =
  `<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>`

// پانویس

s.privacy = `حریم خصوصی`
s.TOS = `شرایط خدمات`

// ویژگی‌های آزمایشی

s.importantCheckbox = `این نظر مهم است`
s.howImportantPrompt = `این عبارت چقدر اهمیت دارد؟`
s.howImportantLow = `کم`
s.howImportantMedium = `متوسط`
s.howImportantHigh = `زیاد`
s.tipStarred = `علامت‌گذاری به‌عنوان مهم.`

s.modSpam = `هرزنامه`
s.modOffTopic = `نامربوط`
s.modImportant = `مهم`
s.modSubmitInitialState = `رد شدن (هیچ‌کدام از موارد بالا)، عبارت بعدی`
s.modSubmit = `انجام شد، عبارت بعدی`

s.topic_good_01 = `برای اتاق پینگ‌پنگ چه باید بکنیم؟`
s.topic_good_01_reason =
  `پایان باز، هرکسی می‌تواند درباره پاسخ‌های این پرسش نظری داشته باشد`
s.topic_good_02 = `درباره این پیشنهاد جدید چه فکر می‌کنید؟`
s.topic_good_02_reason =
  `پایان باز، هرکسی می‌تواند درباره پاسخ‌های این پرسش نظری داشته باشد`
s.topic_good_03 = `می‌توانید موردی بگویید که سرعت بهره‌وری را کم می‌کند؟`

s.topic_bad_01 = `آمادگی شما برای راه‌اندازی را همه گزارش کرده‌اند`
s.topic_bad_01_reason =
  `افراد از تیم‌های مختلف به پاسخ‌ها رأی خواهند داد ولی ممکن است دانش کافی برای رأی دادن بااطمینان نداشته باشند.`
s.topic_bad_02 = `موانع راه‌اندازی ما چه چیزهایی است؟`
s.topic_bad_02_reason = ``

module.exports = s;
