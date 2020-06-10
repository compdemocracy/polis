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
s.helpWriteListStandalone = "独立したアイデアであること";
s.helpWriteListRaisNew = "新しい視点、経験または問題を提起するものであること";
s.helpWriteListShort = "以上を確認し、下のボックスにできるだけ簡潔に追加してください（280字まで）。";
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
s.connectToPostPrompt = "意見するにはメールアドレスまたはFacebookIDでアクセスしてください。あなたのタイムラインには何も表示されません。";
s.connectToVotePrompt = "投票するにはメールアドレスまたはFacebookIDでアクセスしてください。あなたのタイムラインには何も表示されません。";
s.tip = "Tip:";
s.commentWritingTipsHintsHeader = "意見を書くためのコツ";
s.tipCharLimit = "意見は最大で {{char_limit}} 文字です。";
s.tipCommentsRandom = "質問は、管理者の確認後追加され、ランダムに表示されます。";
s.tipOneIdea = "複数のアイデアを含む意見を分けましょう。投票が簡単になります。";
s.tipNoQuestions = "意見は「質問」ではありません。投票者はあなたの意見に賛成するか、反対します。";
s.commentTooLongByChars = "意見は最大で {{CHARACTERS_COUNT}} 文字です。";
s.notSentSinceDemo = "(これはデモンストレーションです)";
s.submitComment = "提出";
s.tipStarred = "重要マークを付ける";
s.participantHelpWelcomeText = "新しい形式の会話へようこそ。他の人の意見に<em>投票</em>してみてください。";
s.participantHelpGroupsText = "意見が似ている人は<span style='font-weight: 700;'>グループにまとめられます。</span>グループをクリックすると、そこの人の視点になれます。<a style='font-weight: 700; cursor: pointer; text-decoration: underline' id='helpTextGroupsExpand'>...more</a>";
s.participantHelpGroupsNotYetText = "7人以上が投票していると、図形が表示されます。";
s.helpWhatAreGroupsDetail = "<p>Amazonの「お勧めの商品」、Netflixの「お勧めの映画」は、統計を使用して、類似のものを購入したり視聴しているユーザをグループ化し、同じグループの他のユーザが購入または視聴しているものを表示します。</p><p>Pol.isでも同様です。グループは以下で確認でき、似たような意見を持つ人々で構成されています。グループをクリックすると、何がそのグループの特徴となっているのかがわかります。</p>";
s.socialConnectPrompt = "ログインしていると、ビジュアルにあなたの位置が表示それます。";
s.connectFbButton = "Facebookでログイン";
s.connectTwButton = "Twitterでログイン";

s.notificationsAlreadySubscribed = "この会話を購読しました。";
s.notificationsGetNotified = "新しい質問が追加されたときに通知を受け取る場合、Subscribeボタンを押してください。";
s.notificationsEnterEmail = "メールアドレスを登録すると、新しい意見が有るときに通知を受け取れます。";
s.labelEmail = "メール";
s.notificationsSubscribeButton = "購読";
s.noCommentsYet = "まだ意見はありません。";
s.noCommentsYetSoWrite = "意見を付けて会話を始めましょう。";
s.noCommentsYetSoInvite = "他の人を招待するか、意見を付けて会話を始めましょう。";
s.noCommentsYouVotedOnAll = "ありがとうございます！すべての質問への投票が完了しました。";
s.noCommentsTryWritingOne = "何か言いたいことが有りましたら、意見を書いてみてください。";
s.notificationsGetNotified = "新しい質問が追加されたときに通知を受け取る場合、Subscribeボタンを押してください。";
s.notificationsEnterEmail = "メールアドレスを登録すると、新しい意見が有るときに通知を受け取れます。";
s.labelEmail = "メール";
s.notificationsSubscribeButton = "購読";
s.noCommentsYet = "まだ意見はありません。";
s.noCommentsYetSoWrite = "意見を付けて会話を始めましょう。";
s.noCommentsYetSoInvite = "他の人を招待するか、意見を付けて会話を始めましょう。";
s.noCommentsYouVotedOnAll = "ありがとうございます！すべての質問への投票が完了しました。";
s.noCommentsTryWritingOne = "何か言いたいことが有りましたら、意見を書いてみてください。";
s.convIsClosed = "この会話は終了しました。";
s.noMoreVotingAllowed = "投票は締め切りました。";


s.showTranslationButton = "日本語に翻訳する";
s.hideTranslationButton = "元の言語に戻す";
s.thirdPartyTranslationDisclaimer = "翻訳サービスは外部から提供されたものです";

module.exports = s;
