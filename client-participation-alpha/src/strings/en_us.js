// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

// Text on the card

s.participantHelpWelcomeText =
  "Welcome to a new kind of conversation — </b>vote</b> on other people's statements — </b> the more the better.</b>";

s.agree = "Agree";
s.disagree = "Disagree";
s.pass = "Pass / Unsure";

s.writePrompt ="Share your perspective (you are not replying — submit a stand-alone statement)";
s.anonPerson = "Anonymous";
s.importantCheckbox = "Important/Significant";
s.importantCheckboxDesc =
  "Check this box if you believe this statement is especially important to you or is highly relevant to the conversation, irrespective of your vote. It will give this statement higher priority compared to your other votes in the conversation analysis.";
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
s.comments_remaining = "{{num_comments}} remaining";
s.comments_remaining2 = "{{num_comments}} remaining statements";

// Text about phasing

s.noCommentsYet = "There aren't any statements yet.";
s.noCommentsYetSoWrite = "Get this conversation started by adding a statement.";
s.noCommentsYetSoInvite =
  "Get this conversation started by inviting more participants, or add a statement.";
s.noCommentsYouVotedOnAll = "You've voted on all the statements.";
s.noCommentsTryWritingOne =
  "If you have something to add, try writing your own statement.";
s.convIsClosed = "This conversation is closed.";
s.noMoreVotingAllowed = "No further voting is allowed.";

// For the visualization below

s.group_123 = "Group:";
s.comment_123 = "Statement:";
s.majorityOpinion = "Majority Opinion";
s.majorityOpinionShort = "Majority";
s.info = "Info";


s.helpWhatAmISeeingTitle = "What am I seeing?";
s.helpWhatAmISeeing =
  "You are represented by the blue circle and grouped with others who share your perspective.";
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
s.pctAgreedLong =
  "{{pct}}% of everyone who voted on statement {{comment_id}} agreed.";
s.pctAgreedOfGroup = "{{pct}}% of Group {{group}} Agreed";
s.pctDisagreedOfGroup = "{{pct}}% of Group {{group}} Disagreed";
s.pctDisagreedLong =
  "{{pct}}% of everyone who voted on statement {{comment_id}} disagreed.";
s.pctAgreedOfGroupLong =
  "{{pct}}% of those in group {{group}} who voted on statement {{comment_id}} agreed.";
s.pctDisagreedOfGroupLong =
  "{{pct}}% of those in group {{group}} who voted on statement {{comment_id}} disagreed.";
s.participantHelpGroupsText =
  "You are represented by the blue circle and grouped with others who share your perspective.";
s.participantHelpGroupsNotYetText =
  "The visualization will appear once 7 participants have begun voting";
s.helpWhatAreGroupsDetail =
  "<p>Click on your group or others to explore each group's opinions.</p><p>Majority opinions are those most widely shared across groups.</p>";

// Text about writing your own statement

s.helpWhatDoIDoTitle = " What do I do?";
s.helpWhatDoIDo =
  "Vote on other people's statements by clicking 'agree' or 'disagree'. Write a statement (keep each to a single idea). Invite your friends to the conversation!";
s.writeCommentHelpText =
  "Are your perspectives or experiences missing from the conversation? If so, </b>add them </b> in the box below — </b>one at a time</b>.";
s.helpWriteListIntro = "What makes for a good statement?";
s.helpWriteListStandalone = "A stand-alone idea";
s.helpWriteListRaisNew = "A new perspective, experience, or issue";
s.helpWriteListShort = "Clear & concise wording (limited to 140 characters)";
s.tip = "Tip:";
s.commentWritingTipsHintsHeader = "Tips for writing statements";
s.tipCharLimit = "Statements are limited to {{char_limit}} characters.";
s.tipCommentsRandom =
  "Statements are displayed randomly and you are not replying directly to other people's statements: <b> you are adding a stand-alone statement.<b>";
s.tipOneIdea =
  "Break up long statements that contain multiple ideas. This makes it easier for others to vote on your statement.";
s.tipNoQuestions =
  "Statements should not be in the form of a question. Participants will agree or disagree with the statements you make.";
s.commentTooLongByChars =
  "Statement length limit exceeded by {{CHARACTERS_COUNT}} characters.";
s.submitComment = "Submit";
s.commentSent =
  "Statement submitted! Only other participants will see your statement and agree or disagree.";

// Error notices

s.commentSendFailed = "There was an error submitting your statement.";
s.commentSendFailedEmpty =
  "There was an error submitting your statement - Statement should not be empty.";
s.commentSendFailedTooLong =
  "There was an error submitting your statement - Statement is too long.";
s.commentSendFailedDuplicate =
  "There was an error submitting your statement - An identical statement already exists.";
s.commentErrorDuplicate = "Duplicate! That statement already exists.";
s.commentErrorConversationClosed =
  "This conversation is closed. No further statements can be submitted.";
s.commentIsEmpty = "Statement is empty";
s.commentIsTooLong = "Statement is too long";
s.hereIsNextStatement = "Vote success. Navigate up to see the next statement.";

// Text for the third party translation that appears on the cards

s.showTranslationButton = "Activate third-party translation";
s.hideTranslationButton = "Deactivate Translation";
s.thirdPartyTranslationDisclaimer = "Translation provided by a third party";

// Text about notifications and subscriptions and embedding

s.notificationsAlreadySubscribed =
  "You are subscribed to updates for this conversation.";
s.notificationsGetNotified = "Get notified when more statements arrive:";
s.notificationsEnterEmail =
  "Enter your email address to get notified when more statements arrive:";
s.labelEmail = "Email";
s.notificationsSubscribeButton = "Subscribe";
s.notificationsSubscribeErrorAlert = "Error subscribing";

s.addPolisToYourSite =
  "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";

// Footer

s.privacy = "Privacy";
s.TOS = "TOS";

// Experimental features

s.importantCheckbox = "This comment is important";
s.howImportantPrompt = "How important is this statement?";
s.howImportantLow = "Low";
s.howImportantMedium = "Medium";
s.howImportantHigh = "High";
s.tipStarred = "Marked as important.";

s.modSpam = "Spam";
s.modOffTopic = "Off Topic";
s.modImportant = "Important";
s.modSubmitInitialState = "Skip (none of the above), next statement";
s.modSubmit = "Done, next statement";

s.topic_good_01 = "What should we do about the ping pong room?";
s.topic_good_01_reason =
  "open ended, anyone can have an opinion on answers to this question";
s.topic_good_02 = "What do you think about the new proposal?";
s.topic_good_02_reason =
  "open ended, anyone can have an opinion on answers to this question";
s.topic_good_03 = "Can you think of anything that's slowing productivity?";

s.topic_bad_01 = "everyone report your launch readiness";
s.topic_bad_01_reason =
  "people from various teams will be voting on the responses, but may not have enough knowledge to vote confidently.";
s.topic_bad_02 = "what are our launch blockers?";
s.topic_bad_02_reason = "";

export default s;


