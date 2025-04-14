// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

// Text on the card

s.participantHelpWelcomeText =
  "欢迎使用一种全新的对话形式：对他人的评论进行<em>投票</em>。请踊跃贡献您的观点。";

s.agree = "赞成";
s.disagree = "反对";
s.pass = "略过/不确定";

s.writePrompt ="分享您的观点（您并不是回复，而是在提交一条独立的评论）";
s.anonPerson = "匿名";
s.importantCheckbox = "重要/意义非凡";
s.importantCheckboxDesc =
  "如果您认为这条评论对您尤为重要，或者与本次对话高度相关，无论您赞成与否，都请勾选此框。在对话分析中，这条评论将会获得比您进行投票的其他评论更高的优先级。";

s.howImportantPrompt = "这条评论的重要程度如何？";
s.howImportantLow = "低";
s.howImportantMedium = "中";
s.howImportantHigh = "高";

s.modSpam = "垃圾内容";
s.modOffTopic = "偏离主题";
s.modImportant = "重要";
s.modSubmitInitialState = "跳过（以上都不是），查看下一条评论";
s.modSubmit = "完成，查看下一条评论";

s.x_wrote = "写道：";
s.x_tweeted = "发推：";
s.comments_remaining = "还剩 {{num_comments}} 条";
s.comments_remaining2 = "还剩 {{num_comments}} 条评论";

// Text about phasing

s.noCommentsYet = "尚无任何评论。";
s.noCommentsYetSoWrite = "添加评论，以开始此对话。";
s.noCommentsYetSoInvite =
  "邀请更多参与者或添加评论，以开始此对话。";
s.noCommentsYouVotedOnAll = "您已完成对所有评论的投票。";
s.noCommentsTryWritingOne =
  "如有任何看法，不妨撰写您自己的评论。";
s.convIsClosed = "本次对话已关闭。";
s.noMoreVotingAllowed = "无法继续投票。";

// For the visualization below

s.group_123 = "群组：";
s.comment_123 = "评论：";
s.majorityOpinion = "多数意见";
s.majorityOpinionShort = "多数";
s.info = "信息";


s.helpWhatAmISeeingTitle = "我看到了什么？";
s.helpWhatAmISeeing =
  "蓝色圆圈代表您，您和与您持相同观点的其他人被归类到同一群组。";
s.heresHowGroupVoted = "这是群组 {{GROUP_NUMBER}} 的投票情况：";
s.one_person = "{{x}} 人";
s.x_people = "{{x}} 人";
s.acrossAllPtpts = "所有参与者：";
s.xPtptsSawThisComment = " 看过这条评论";
s.xOfThoseAgreed = " 位参与者表示赞成";
s.xOfthoseDisagreed = " 位参与者表示反对";
s.opinionGroups = "意见群组";
s.topComments = "热门评论";
s.divisiveComments = "存在争议的评论";
s.pctAgreed = "{{pct}}% 的参与者表示赞成";
s.pctDisagreed = "{{pct}}% 的参与者表示反对";
s.pctAgreedLong =
  "对评论 {{comment_id}} 进行投票的所有参与者中，{{pct}}% 的参与者表示赞成。";
s.pctAgreedOfGroup = "在群组 {{group}} 中，{{pct}}% 的参与者表示赞成";
s.pctDisagreedOfGroup = "在群组 {{group}} 中，{{pct}}% 的参与者表示反对";
s.pctDisagreedLong =
  "对评论 {{comment_id}} 进行投票的所有参与者中，{{pct}}% 的参与者表示反对。";
s.pctAgreedOfGroupLong =
  "群组 {{group}} 中对评论 {{comment_id}} 进行投票的参与者中，{{pct}}% 的参与者表示赞成。";
s.pctDisagreedOfGroupLong =
  "群组 {{group}} 中对评论 {{comment_id}} 进行投票的参与者中，{{pct}}% 的参与者表示反对。";
s.participantHelpGroupsText =
  "蓝色圆圈代表您，您和与您持相同观点的其他人被归类到同一群组。";
s.participantHelpGroupsNotYetText =
  "只要有 7 位参与者开始投票，就会显示可视化图表";
s.helpWhatAreGroupsDetail =
  "<p>点击您的群组或其他群组，即可了解每个群组的意见。</p><p>“多数意见”是指最受各群组认可的意见。</p>";

// Text about writing your own statement

s.helpWhatDoIDoTitle = "我可以做什么？";
s.helpWhatDoIDo =
  "点击“赞成”或“反对”，对其他人的评论进行投票。撰写自己的评论（每条评论表述一个观点）。邀请您的朋友参与对话！";
s.writeCommentHelpText =
  "对话中没有体现您的观点或体验？如果没有，可在下框中</b>发表您的评论</b>，</b>每条评论表述一个观点或体验</b>。";
s.helpWriteListIntro = "什么样的评论才是好评论？";
s.helpWriteListStandalone = "有独立思考";
s.helpWriteListRaisNew = "有新的观点、体验或问题";
s.helpWriteListShort = "措辞简洁明了（限制在 140 个字符以内）";
s.tip = "技巧：";
s.commentWritingTipsHintsHeader = "撰写评论的技巧";
s.tipCharLimit = "将评论限制在 {{char_limit}} 个字符以内。";
s.tipCommentsRandom =
  "评论随机展示，不建议您直接回复他人的评论：<b> 建议您添加自己的独立评论。<b>";
s.tipOneIdea =
  "如果评论较长，包含多个观点，请将它分成多条评论进行表述，以便于他人对您的评论进行投票。";
s.tipNoQuestions =
  "评论不应使用问句。参与者会对您的评论表示赞成或反对。";
s.commentTooLongByChars =
  "评论长度超出 {{CHARACTERS_COUNT}} 个字符。";
s.submitComment = "提交";
s.commentSent =
  "评论已提交！只有其他参与者能够看到您的评论，并对其表示赞成或反对。";

// Error notices

s.commentSendFailed = "提交评论时出现错误。";
s.commentSendFailedEmpty =
  "提交评论时出现错误 - 评论不能为空。";
s.commentSendFailedTooLong =
  "提交评论时出现错误 - 评论过长。";
s.commentSendFailedDuplicate =
  "提交评论时出现错误 - 已存在相同评论。";
s.commentErrorDuplicate = "重复！这条评论已存在。";
s.commentErrorConversationClosed =
  "本次对话已关闭，无法继续提交新评论。";
s.commentIsEmpty = "评论为空";
s.commentIsTooLong = "评论过长";
s.hereIsNextStatement = "投票成功。继续查看下一条评论。";

// Text about connecting identity

s.connectFacebook = "关联 Facebook";
s.connectTwitter = "关联 Twitter";
s.connectToPostPrompt =
  "关联身份以提交评论。此评论不会发布到您的时间轴上。";
s.connectToVotePrompt =
  "关联身份以投票。此次投票不会发布到您的时间轴上。";
s.socialConnectPrompt =
  "（可选）关联您的社交账号，即可在可视化图表中看到您的朋友和关注的人。";
s.connectFbButton = "关联 Facebook";
s.connectTwButton = "关联 Twitter";
s.polis_err_reg_fb_verification_email_sent =
  "请通过电子邮件中的验证链接完成验证，然后返回此处继续。";
s.polis_err_reg_fb_verification_noemail_unverified =
  "您的 Facebook 账号未经验证。请通过 Facebook 验证您的电子邮件地址，然后返回此处继续。";

// Text for the third party translation that appears on the cards

s.showTranslationButton = "启用第三方翻译";
s.hideTranslationButton = "停用翻译";
s.thirdPartyTranslationDisclaimer = "由第三方提供的翻译";

// Text about notifications and subscriptions and embedding

s.notificationsAlreadySubscribed =
  "您已订阅此对话的动态。";
s.notificationsGetNotified = "在有新评论时收到通知：";
s.notificationsEnterEmail =
  "输入您的电子邮件地址，在有新评论时收到通知：";
s.labelEmail = "电子邮件";
s.notificationsSubscribeButton = "订阅";
s.notificationsSubscribeErrorAlert = "订阅时出错";

s.addPolisToYourSite =
  "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";

// Footer

s.privacy = "隐私设置";
s.TOS = "服务条款 (TOS)";

// Experimental features

s.importantCheckbox = "这条评论很重要";
s.howImportantPrompt = "这条评论的重要程度如何？";
s.howImportantLow = "低";
s.howImportantMedium = "中";
s.howImportantHigh = "高";
s.tipStarred = "标记为重要。";

s.modSpam = "垃圾内容";
s.modOffTopic = "偏离主题";
s.modImportant = "重要";
s.modSubmitInitialState = "跳过（以上都不是），查看下一条评论";
s.modSubmit = "完成，查看下一条评论";

s.topic_good_01 = "我们应该如何处理乒乓球室？";
s.topic_good_01_reason =
  "开放式问题，任何人都可以对此问题的答案各抒己见";
s.topic_good_02 = "你认为这个新提案怎么样？";
s.topic_good_02_reason =
  "开放式问题，任何人都可以对此问题的答案各抒己见";
s.topic_good_03 = "你能想到效率降低的原因吗？";

s.topic_bad_01 = "每个人都汇报一下你们的发布前准备情况";
s.topic_bad_01_reason =
  "各团队的成员在对回答进行投票时，可能不具备足够的知识来支撑他们进行有把握的投票。";
s.topic_bad_02 = "阻碍发布的因素有哪些？";
s.topic_bad_02_reason = "";

module.exports = s;

