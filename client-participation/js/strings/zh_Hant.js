// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

// Text on the card

s.participantHelpWelcomeText =
  "歡迎使用新型對話功能：<em></em>對他人的陳述「投票」，投得越多，成效越佳。";

s.agree = "同意";
s.disagree = "不同意";
s.pass = "跳過/不確定";

s.writePrompt ="分享你的觀點 (不是回覆，而是提出獨立陳述)";
s.anonPerson = "匿名";
s.importantCheckbox = "重要/意義重大";
s.importantCheckboxDesc =
  "不管你先前怎麼投票，只要認為這則陳述特別重要，或是與對話高度相關，即可勾選此方塊。如此一來，在對話分析時，這則陳述的參考順序就會高於其他投票。";

s.howImportantPrompt = "這則陳述的重要性多高？";
s.howImportantLow = "低";
s.howImportantMedium = "中";
s.howImportantHigh = "高";

s.modSpam = "垃圾內容";
s.modOffTopic = "離題";
s.modImportant = "重要";
s.modSubmitInitialState = "略過 (以上皆非)，跳到下則陳述";
s.modSubmit = "完成，跳到下則陳述";

s.x_wrote = "撰寫了陳述：";
s.x_tweeted = "發布了推文：";
s.comments_remaining = "還有 {{num_comments}} 則";
s.comments_remaining2 = "還有 {{num_comments}} 則陳述";

// Text about phasing

s.noCommentsYet = "尚無陳述。";
s.noCommentsYetSoWrite = "新增陳述，展開對話。";
s.noCommentsYetSoInvite =
  "邀請更多參與者或新增陳述，展開對話。";
s.noCommentsYouVotedOnAll = "你已對所有陳述投票。";
s.noCommentsTryWritingOne =
  "如想補充，可以試著自行撰寫陳述。";
s.convIsClosed = "此對話已關閉。";
s.noMoreVotingAllowed = "投票已結束。";

// For the visualization below

s.group_123 = "群組：";
s.comment_123 = "陳述：";
s.majorityOpinion = "多數意見";
s.majorityOpinionShort = "多數";
s.info = "資訊";


s.helpWhatAmISeeingTitle = "顯示的內容代表什麼？";
s.helpWhatAmISeeing =
  "藍色圓圈代表你，與你持相同觀點的人歸在同組。";
s.heresHowGroupVoted = "第 {{GROUP_NUMBER}} 組的投票結果如下：";
s.one_person = "{{x}} 人";
s.x_people = "{{x}} 人";
s.acrossAllPtpts = "所有參與者中：";
s.xPtptsSawThisComment = "看過這則陳述";
s.xOfThoseAgreed = "的參與者同意";
s.xOfthoseDisagreed = "的參與者不同意";
s.opinionGroups = "意見小組";
s.topComments = "意見最一致的陳述";
s.divisiveComments = "意見分歧的陳述";
s.pctAgreed = "{{pct}}% 同意";
s.pctDisagreed = "{{pct}}% 不同意";
s.pctAgreedLong =
  "對陳述「{{comment_id}}」投票的人中有 {{pct}}% 同意。";
s.pctAgreedOfGroup = "群組「{{group}}」中有 {{pct}}% 的人同意";
s.pctDisagreedOfGroup = "群組「{{group}}」組中有 {{pct}}% 的人不同意";
s.pctDisagreedLong =
  "對陳述「{{comment_id}}」投票的人中有{{pct}}% 不同意。";
s.pctAgreedOfGroupLong =
  "群組「{{group}}」內對陳述「{{comment_id}}」投票的人中，有 {{pct}}% 同意。";
s.pctDisagreedOfGroupLong =
  "群組「{{group}}」內對陳述「{{comment_id}}」投票的人中，有 {{pct}} 不同意。";
s.participantHelpGroupsText =
  "藍色圓圈代表你，與你持相同觀點的人歸在同組。";
s.participantHelpGroupsNotYetText =
  "一旦有 7 位參與者開始投票，系統就會顯示圖表";
s.helpWhatAreGroupsDetail =
  "<p>按一下你所屬的組別或其他群組，查看各組意見。</p><p>多數意見為獲得各組共識的意見。</p>";

// Text about writing your own statement

s.helpWhatDoIDoTitle = " 該怎麼做？";
s.helpWhatDoIDo =
  "按一下「同意」或「不同意」即可對他人的陳述投票。你還可以撰寫陳述 (每則表達一個概念)，邀請朋友參與對話！";
s.writeCommentHelpText =
  "想在對話中補充你的觀點或經驗嗎？請在底下方塊中</b>新增內容</b>，</b>一次表達一個概念</b>。";
s.helpWriteListIntro = "怎樣算是好的陳述？";
s.helpWriteListStandalone = "表達單一概念";
s.helpWriteListRaisNew = "表達新觀點、經驗或議題";
s.helpWriteListShort = "措辭簡潔明瞭 (上限 140 個半形字元)";
s.tip = "訣竅：";
s.commentWritingTipsHintsHeader = "陳述撰寫訣竅";
s.tipCharLimit = "陳述不得超過 {{char_limit}} 個半形字元。";
s.tipCommentsRandom =
  "由於陳述會隨機顯示，而你無法直接回應他人的陳述，因此<b>請另增單一陳述。<b>";
s.tipOneIdea =
  "將包含數個概念的冗長陳述拆解，方便別人對你的陳述投票。";
s.tipNoQuestions =
  "陳述不得採問句形式，參與者只能對你的陳述表達同意/不同意。";
s.commentTooLongByChars =
  "陳述超出上限 ({{CHARACTERS_COUNT}} 個半形字元)。";
s.submitComment = "提交";
s.commentSent =
  "陳述已提交！只有其他參與者會看到你的陳述，並且表達同意與否。";

// Error notices

s.commentSendFailed = "提交陳述時發生錯誤。";
s.commentSendFailedEmpty =
  "提交陳述時發生錯誤：陳述不得空白。";
s.commentSendFailedTooLong =
  "提交陳述時發生錯誤：陳述過長。";
s.commentSendFailedDuplicate =
  "提交陳述時發生錯誤：已有相同陳述。";
s.commentErrorDuplicate = "內容重複！已有相同陳述。";
s.commentErrorConversationClosed =
  "對話已關閉，無法再提交陳述。";
s.commentIsEmpty = "陳述空白";
s.commentIsTooLong = "陳述過長";
s.hereIsNextStatement = "投票成功。返回查看下一則陳述。";

// Text about connecting identity

s.connectFacebook = "連結 Facebook 帳戶";
s.connectTwitter = "連結 Twitter 帳戶";
s.connectToPostPrompt =
  "連結識別資訊帳戶即可提交陳述。我們不會在你的動態時報上發布內容。";
s.connectToVotePrompt =
  "連結識別資訊帳戶即可投票。我們不會在你的動態時報上發布內容。";
s.socialConnectPrompt =
  "你可以視需要連結帳戶，以圖表查看朋友和追蹤對象的資料。";
s.connectFbButton = "連結 Facebook 帳戶";
s.connectTwButton = "連結 Twitter 帳戶";
s.polis_err_reg_fb_verification_email_sent =
  "請查看你的電子郵件，點選收到的驗證連結，然後回到這裡繼續操作。";
s.polis_err_reg_fb_verification_noemail_unverified =
  "你的 Facebook 帳戶未通過驗證。請向 Facebook 驗證你的電子郵件地址，然後回到這裡繼續操作。";

// Text for the third party translation that appears on the cards

s.showTranslationButton = "啟用第三方翻譯";
s.hideTranslationButton = "停用翻譯";
s.thirdPartyTranslationDisclaimer = "第三方提供的翻譯";

// Text about notifications and subscriptions and embedding

s.notificationsAlreadySubscribed =
  "你已訂閱與此對話相關的最新消息。";
s.notificationsGetNotified = "接收新陳述通知：";
s.notificationsEnterEmail =
  "輸入電子郵件地址即可接收新陳述通知：";
s.labelEmail = "電子郵件地址";
s.notificationsSubscribeButton = "訂閱";
s.notificationsSubscribeErrorAlert = "訂閱時發生錯誤";

s.addPolisToYourSite =
  "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";

// Footer

s.privacy = "隱私權";
s.TOS = "服務條款";

// Experimental features

s.importantCheckbox = "這則評論很重要";
s.howImportantPrompt = "這則陳述的重要性多高？";
s.howImportantLow = "低";
s.howImportantMedium = "中";
s.howImportantHigh = "高";
s.tipStarred = "標示為重要。";

s.modSpam = "垃圾內容";
s.modOffTopic = "離題";
s.modImportant = "重要";
s.modSubmitInitialState = "略過 (以上皆非)，跳到下則陳述";
s.modSubmit = "完成，跳到下則陳述";

s.topic_good_01 = "我們該怎麼規劃乒乓球室？";
s.topic_good_01_reason =
  "無限制，所有人都能對此問題的答覆表達意見";
s.topic_good_02 = "你對新提案有什麼想法？";
s.topic_good_02_reason =
  "無限制，所有人都能對此問題的答覆表達意見";
s.topic_good_03 = "你能想到任何會降低工作效率的因素嗎？";

s.topic_bad_01 = "請大家回報發布準備進度";
s.topic_bad_01_reason =
  "各團隊成員會對回覆內容投票，但可能不夠瞭解情況，無法肯定判斷。";
s.topic_bad_02 = "有哪些因素阻礙了發布進度？";
s.topic_bad_02_reason = "";

module.exports = s;
