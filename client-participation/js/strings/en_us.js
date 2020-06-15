// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

s.agree = "Agree";
s.disagree = "Disagree";
s.pass = "Pass / Unsure";

s.importantCheckbox = "This comment is important";
s.howImportantPrompt = "How important is this statement?";
s.howImportantLow = "Low";
s.howImportantMedium = "Medium";
s.howImportantHigh = "High";

s.modSpam = "Spam";
s.modOffTopic = "Off Topic";
s.modImportant = "Important";
s.modSubmitInitialState = "Skip (none of the above), next statement";
s.modSubmit = "Done, next statement";

s.x_wrote = "wrote:";
s.x_tweeted = "tweeted:";
s.comments_remaining = "{{num_comments}} remaining";
s.comments_remaining2 = "{{num_comments}} remaining statements";
s.group_123 = "Group:";
s.comment_123 = "Statement:";
s.majorityOpinion = "Majority Opinion";
s.majorityOpinionShort = "Majority";
s.info = "Info";
s.addPolisToYourSite = "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";
s.privacy = "Privacy";
s.TOS = "TOS";
s.writePrompt = "Share your perspective...";
s.anonPerson = "Anonymous";
s.helpWhatAmISeeingTitle = "What am I seeing?";
s.helpWhatAmISeeing = "People who vote similarly are grouped. Click a group to see which viewpoints they share.";
s.helpWhatDoIDoTitle = " What do I do?";
s.helpWhatDoIDo = "Vote on other people's statements by clicking 'agree' or 'disagree'. Write a statement (keep each to a single idea). Invite your friends to the conversation!";
s.writeCommentHelpText = "Are your perspectives or experiences missing from the conversation? If so, <b>add them</b> in the box below.";
s.helpWriteListIntro = "What makes a good statement?";
s.helpWriteListStandalone = "Stand alone idea";
s.helpWriteListRaisNew = "Raise new perspectives, experiences or issues";
s.helpWriteListShort = "Clear & concise (limited to 140 characters)";
s.heresHowGroupVoted = "Here's how Group {{GROUP_NUMBER}} voted:";
s.one_person = "{{x}} person";
s.x_people = "{{x}} people";
s.acrossAllPtpts = "Across all participants:";
s.xPtptsSawThisComment = " saw this statement";
s.xOfThoseAgreed = "of those participants agreed";
s.xOfthoseDisagreed = "of those participants disagreed";
s.opinionGroups = "Opinion Groups";
s.topComments = "Top Statements";
s.divisiveComments = "Divisive Statements";
s.pctAgreed = "{{pct}}% Agreed";
s.pctDisagreed = "{{pct}}% Disagreed";
s.pctAgreedLong = "{{pct}}% of everyone who voted on statement {{comment_id}} agreed.";
s.pctAgreedOfGroup = "{{pct}}% of Group {{group}} Agreed";
s.pctDisagreedOfGroup = "{{pct}}% of Group {{group}} Disagreed";
s.pctDisagreedLong = "{{pct}}% of everyone who voted on statement {{comment_id}} disagreed.";
s.pctAgreedOfGroupLong = "{{pct}}% of those in group {{group}} who voted on statement {{comment_id}} agreed.";
s.pctDisagreedOfGroupLong = "{{pct}}% of those in group {{group}} who voted on statement {{comment_id}} disagreed.";
s.commentSent = "Statement submitted! Only other participants will see your statement and agree or disagree.";
s.commentSendFailed = "There was an error submitting your statement.";
s.commentSendFailedEmpty = "There was an error submitting your statement - Statement should not be empty.";
s.commentSendFailedTooLong = "There was an error submitting your statement - Statement is too long.";
s.commentSendFailedDuplicate = "There was an error submitting your statement - An identical statement already exists.";
s.commentErrorDuplicate = "Duplicate! That statement already exists.";
s.commentErrorConversationClosed = "This conversation is closed. No further statements can be submitted.";
s.commentIsEmpty = "Statement is empty";
s.commentIsTooLong = "Statement is too long";
s.hereIsNextStatement = "Vote success. Navigate up to see the next statement.";

s.connectFacebook = "Connect Facebook";
s.connectTwitter = "Connect Twitter";
s.connectToPostPrompt = "Connect an identity to submit a statement. We will not post to your timeline.";
s.connectToVotePrompt = "Connect an identity to vote. We will not post to your timeline.";
s.tip = "Tip:";
s.commentWritingTipsHintsHeader = "Tips for writing statements";
s.tipCharLimit = "Statements are limited to {{char_limit}} characters.";
s.tipCommentsRandom = "Please remember, statements are displayed randomly and you are not replying directly to other participants' statements.";
s.tipOneIdea = "Break up long statements that contain multiple ideas. This makes it easier for others to vote on your statement.";
s.tipNoQuestions = "Statements should not be in the form of a question. Participants will agree or disagree with the statements you make.";
s.commentTooLongByChars = "Statement length limit exceeded by {{CHARACTERS_COUNT}} characters.";
s.notSentSinceDemo = "(not really, this is a demo)";
s.submitComment = "Submit";
s.tipStarred = "Marked as important.";
s.participantHelpWelcomeText = "Welcome to a new kind of conversation - <em>vote</em> on other people's statements.";
s.participantHelpGroupsText = "People who vote similarly <span style='font-weight: 700;'>are grouped.</span> Click a group to see which viewpoints they share. <a style='font-weight: 700; cursor: pointer; text-decoration: underline' id='helpTextGroupsExpand'>...more</a>";
s.participantHelpGroupsNotYetText = "The visualization will appear once 7 participants have begun voting";
s.helpWhatAreGroupsDetail = "<p>You've probably seen 'recommended products' on Amazon, or 'recommended movies' on Netflix. Each of those services uses statistics to group the user with people who buy and watch similar things, then show them things that those people bought or watched.</p> <p> When a user votes on statements, they are grouped with people who voted like they did! You can see those groups below. Each is made up of people who have similar opinions. There are fascinating insights to discover in each conversation. Go ahead - click a group to see what brought them together and what makes them unique! </p>";
s.socialConnectPrompt = "Optionally connect to see friends and people you follow in the visualization.";
s.connectFbButton = "Connect with Facebook";
s.connectTwButton = "Connect with Twitter";
s.polis_err_reg_fb_verification_email_sent = "Please check your email for a verification link, then return here to continue.";
s.polis_err_reg_fb_verification_noemail_unverified = "Your Facebook account is unverified. Please verify your email address with Facebook, then return here to continue.";
s.showTranslationButton = "Activate third-party translation";
s.hideTranslationButton = "Deactivate Translation";
s.thirdPartyTranslationDisclaimer = "Translation provided by a third party";

s.notificationsAlreadySubscribed = "You are subscribed to updates for this conversation.";
s.notificationsGetNotified = "Get notified when more statements arrive:";
s.notificationsEnterEmail = "Enter your email address to get notified when more statements arrive:";
s.labelEmail = "Email";
s.notificationsSubscribeButton = "Subscribe";
s.notificationsSubscribeErrorAlert = "Error subscribing";
s.noCommentsYet = "There aren't any statements yet.";
s.noCommentsYetSoWrite = "Get this conversation started by adding a statement.";
s.noCommentsYetSoInvite = "Get this conversation started by inviting more participants, or add a statement.";
s.noCommentsYouVotedOnAll = "You've voted on all the statements.";
s.noCommentsTryWritingOne = "If you have something to add, try writing your own statement.";
s.convIsClosed = "This conversation is closed.";
s.noMoreVotingAllowed = "No further voting is allowed.";


s.topic_good_01 = "What should we do about the pingpong room?";
s.topic_good_01_reason = "open ended, anyone can have an opinion on answers to this question";
s.topic_good_02 = "What do you think about the new proposal?";
s.topic_good_02_reason = "open ended, anyone can have an opinion on answers to this question";
s.topic_good_03 = "Can you think of anything that's slowing productivity?";

s.topic_bad_01 = "everyone report your launch readiness";
s.topic_bad_01_reason = "people from various teams will be voting on the responses, but may not have enough knowledge to vote confidently.";
s.topic_bad_02 = "what are our launch blockers?";
s.topic_bad_02_reason = "";


module.exports = s;
