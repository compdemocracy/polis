// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.


var s = {};

s.agree = "賛成";
s.disagree = "反対";
s.pass = "わからない/どちらでもない";

s.x_wrote = "から：";
s.x_tweeted = "がツイートしました：";
s.comments_remaining = "残り {{num_comments}} 問";
s.comments_remaining2 = "{{num_comments}} が残っています";
s.group_123 = "グループ：";
s.comment_123 = "意見：";
s.majorityOpinion = "メジャーな意見";
s.majorityOpinionShort = "メジャリティ";
s.info = "インフォ";
s.addPolisToYourSite = "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";
s.privacy = "プライバシー";
s.TOS = "TOS";
s.writePrompt = "あなたの考え方を共有しよう……";
s.anonPerson = "匿名";
s.helpWhatAmISeeing = "投票傾向が似ている人々がグループ化されます。グループをクリックすると、どの視点を共有しているのかを確認できます。";
s.writeCommentHelpText = "上記の質問に、あなたの意見やアイデアが含まれていない場合、";
s.helpWriteListIntro = "";
s.helpWriteListStandalone = "・独立したアイデアであること";
s.helpWriteListRaisNew = "・新しい視点、経験または問題を提起するものであること";
s.helpWriteListShort = "を確認し、下のボックスにできるだけ簡潔に追加してください（280字まで）。";
s.heresHowGroupVoted = "これはグループ {{GROUP_NUMBER}} がどう投票したのか：";
s.one_person = "{{x}} 人";
s.x_people = "{{x}} 人";
s.acrossAllPtpts = "全ての参加者の中に：";
s.xPtptsSawThisComment = " がこの意見を見ました";
s.xOfThoseAgreed = "の参加者が賛成しました";
s.xOfthoseDisagreed = "の参加者が反対しました";
s.opinionGroups = "意見グループ";
s.topComments = "トップ意見";
s.divisiveComments = "別れた意見";
s.pctAgreed = "{{pct}}% が賛成しました";
s.pctDisagreed = "{{pct}}% が反対しました";
s.pctAgreedLong = "{{comment_id}} に投票した {{pct}}% の人が賛成しました。";
s.pctAgreedOfGroup = "グループ {{group}} の {{pct}}% が賛成しました。";
s.pctDisagreedOfGroup = "グループ {{group}} の {{pct}}% が反対しました。";
s.pctDisagreedLong = "{{comment_id}} に投票した {{pct}}% の人が反対しました。";
s.pctAgreedOfGroupLong = "グループ {{group}} で意見 {{comment_id}} に投票した人の {{pct}}% が賛成しました。";
s.pctDisagreedOfGroupLong = "グループ {{group}} で意見 {{comment_id}} に投票した人の {{pct}}% が反対しました。";
s.commentSent = "質問の追加を提案しました。管理者の確認終了後、他のユーザに質問として表示されます。";
s.commentSendFailed = "意見提出にエラーが発生しました。";
s.commentSendFailedEmpty = "意見提出にエラーが発生しました－意見内容を入力してください。";
s.commentSendFailedTooLong = "意見提出にエラーが発生しました－意見内容が長すぎます。";
s.commentSendFailedDuplicate = "意見提出にエラーが発生しました－同じ意見が既にあります。";
s.commentErrorDuplicate = "同じ意見が既にあります。";
s.commentErrorConversationClosed = "この会話は締め切りました。";
s.commentIsEmpty = "意見が空です。";
s.commentIsTooLong = "意見が長すぎます。";
s.hereIsNextStatement = "投票に成功しました。次の意見に行きましょう。";

s.emailLogin = "メールでログイン";
s.connectFacebook = "Facebookでログイン";
s.connectTwitter = "Twitterでログイン";
s.connectToPostPrompt = "意見するにはメールアドレスまたはFacebookIDでアクセスしてください。<br>あなたのタイムラインには何も表示されません。";
s.connectToVotePrompt = "投票するにはメールアドレスまたはFacebookIDでアクセスしてください。<br>あなたのタイムラインには何も表示されません。";
s.tip = "Tip:";
s.commentWritingTipsHintsHeader = "Tips for writing statements";
s.tipCharLimit = "意見は最大で {{char_limit}} 文字です。";
s.tipCommentsRandom = "質問は、管理者の確認後追加され、ランダムに表示されます。";
s.tipOneIdea = "Break up long statements that contain multiple ideas. This makes it easier for others to vote on your statement.";
s.tipNoQuestions = "Statements should not be in the form of a question. Participants will agree or disagree with the statements you make.";
s.commentTooLongByChars = "Statement length limit exceeded by {{CHARACTERS_COUNT}} characters.";
s.notSentSinceDemo = "(not really, this is a demo)";
s.submitComment = "提出";
s.tipStarred = "Marked as important.";
s.participantHelpWelcomeText = "Welcome to a new kind of conversation - <em>vote</em> on other people's statements.";
s.participantHelpGroupsText = "People who vote similarly <span style='font-weight: 700;'>are grouped.</span> Click a group to see which viewpoints they share. <a style='font-weight: 700; cursor: pointer; text-decoration: underline' id='helpTextGroupsExpand'>...more</a>";
s.participantHelpGroupsNotYetText = "The visualization will appear once 7 participants have begun voting";
s.helpWhatAreGroupsDetail = "<p>Amazonの「お勧めの商品」、Netflixの「お勧めの映画」は、統計を使用して、類似のものを購入したり視聴しているユーザをグループ化し、同じグループの他のユーザが購入または視聴しているものを表示します。</p><p>Pol.isでも同様です。グループは以下で確認でき、似たような意見を持つ人々で構成されています。グループをクリックすると、何がそのグループの特徴となっているのかがわかります。</p>";
s.socialConnectPrompt = "Optionally connect to see friends and people you follow in the visualization.";
s.connectFbButton = "Facebookでログイン";
s.connectTwButton = "Twitterでログイン";
s.polis_err_reg_fb_verification_email_sent = "Please check your email for a verification link, then return here to continue.";
s.polis_err_reg_fb_verification_noemail_unverified = "Your Facebook account is unverified. Please verify your email address with Facebook, then return here to continue.";

s.notificationsAlreadySubscribed = "この会話を購読しました。";
s.notificationsGetNotified = "新しい質問が追加されたときに通知を受け取る場合、Subscribeボタンを押してください。";
s.notificationsEnterEmail = "Enter your email address to get notified when more statements arrive:";
s.labelEmail = "メール";
s.notificationsSubscribeButton = "購読";
s.noCommentsYet = "まだ意見はありません。";
s.noCommentsYetSoWrite = "Get this conversation started by adding a statement.";
s.noCommentsYetSoInvite = "Get this conversation started by inviting more participants, or add a statement.";
s.noCommentsYouVotedOnAll = "ありがとうございます！すべての質問への投票が完了しました。";
s.noCommentsTryWritingOne = "If you have something to add, try writing your own statement.";
s.convIsClosed = "This conversation is closed.";
s.noMoreVotingAllowed = "投票は締め切りました。";


s.showTranslationButton = "日本語に翻訳する";
s.hideTranslationButton = "元の言語に戻す";
s.thirdPartyTranslationDisclaimer = "翻訳サービスは外部から提供されたものです";

module.exports = s;
