// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

s.agree = "Agree";
s.disagree = "Disagree";
s.pass = "Pass / Unsure";

s.modSpam = "Spam";
s.modOffTopic = "Off Topic";
s.modImportant = "Important";
s.modSubmitInitialState = "Skip (none of the above), next comment";
s.modSubmit = "Done, next comment";

s.x_wrote = "wrote:";
s.x_tweeted = "tweeted:";
s.comments_remaining = "{{num_comments}} remaining";
s.comments_remaining2 = "{{num_comments}} remaining comments";
s.group_123 = "Group:";
s.comment_123 = "Comment:";
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
s.helpWhatDoIDo = "Vote on other people's comments by clicking 'agree' or 'disagree'. Write a comment (keep each to a single idea). Invite your friends to the discussion!";
s.writeCommentHelpText = "If your perspective isn't already represented, <strong>write</strong> a comment!</i>";
s.heresHowGroupVoted = "Here's how Group {{GROUP_NUMBER}} voted:";
s.one_person = "{{x}} person";
s.x_people = "{{x}} people";
s.acrossAllPtpts = "Across all participants:";
s.xPtptsSawThisComment = " saw this comment";
s.xOfThoseAgreed = "of those participants agreed";
s.xOfthoseDisagreed = "of those participants disagreed";
s.opinionGroups = "Opinion Groups";
s.pctAgreed = "{{pct}}% Agreed";
s.pctDisagreed = "{{pct}}% Disagreed";
s.pctAgreedLong = "{{pct}}% of everyone who voted on comment {{comment_id}} agreed.";
s.pctAgreedOfGroup = "{{pct}}% of Group {{group}} Agreed";
s.pctDisagreedOfGroup = "{{pct}}% of Group {{group}} Disagreed";
s.pctDisagreedLong = "{{pct}}% of everyone who voted on comment {{comment_id}} disagreed.";
s.pctAgreedOfGroupLong = "{{pct}}% of those in group {{group}} who voted on comment {{comment_id}} agreed.";
s.pctDisagreedOfGroupLong = "{{pct}}% of those in group {{group}} who voted on comment {{comment_id}} disagreed.";
s.commentSent = "Comment Sent! Other participants will see your comment and agree or disagree.";
s.commentSendFailed = "There was an error submitting your comment.";
s.commentErrorDuplicate = "Duplicate! That comment already exists.";
s.commentErrorConversationClosed = "This conversation is closed. No further commenting is allowed.";
s.commentIsEmpty = "Comment is empty";
s.commentIsTooLong = "Comment is too long";

s.connectFacebook = "Connect Facebook";
s.connectTwitter = "Connect Twitter";
s.connectToPostPrompt = "Connect an identity to comment. We will not post to your timeline.";
s.connectToVotePrompt = "Connect an identity to vote. We will not post to your timeline.";
s.tip = "Tip:";
s.commentWritingTipsHintsHeader = "Tips for writing comments";
s.tipCharLimit = "Comments are limited to {{char_limit}} characters.";
s.tipCommentsRandom = "Comments are displayed randomly. You are not directly replying to anyone.";
s.tipOneIdea = "Break up long comments that contain multiple ideas. This makes it easier for others to vote on your comment.";
s.tipNoQuestions = "Comments should make statements rather than ask questions. Participants will agree or disagree with the statements you make.";
s.commentTooLongByChars = "Comment length limit exceeded by {{CHARACTERS_COUNT}} characters.";
s.notSentSinceDemo = "(not really, this is a demo)";
s.submitComment = "Submit";
s.tipStarred = "Marked as important.";
s.participantHelpWelcomeText = "Welcome to a new kind of discussion - <span style='font-weight: 700;'>vote</span> on people's opinions and contribute your own.";
s.participantHelpGroupsText = "People who vote similarly <span style='font-weight: 700;'>are grouped.</span> Click a group to see which viewpoints they share <a style='font-weight: 700; cursor: pointer; text-decoration: underline' id='helpTextGroupsExpand'>...more</a>";
s.participantHelpGroupsNotYetText = "The visualization will appear once 7 participants have begun voting";
s.helpWhatAreGroupsDetail = "<p>You've probably seen 'recommended products' on Amazon, or 'recommended movies' on Netflix. Each of those services uses statistics to group you with people who buy and watch similar things, then show you things that those people bought or watched.</p> <p> When you cast a vote on a comment, you are grouped with people who voted like you did! You can see those groups below. Each is made up of people who have similar opinions. There are fascinating insights to discover in each conversation. Go ahead - click a group to see what brought them together and what makes them unique! </p>";
s.socialConnectPrompt = "Optionally connect to see friends and people you follow in the visualization.";
s.connectFbButton = "Connect with Facebook";
s.connectTwButton = "Connect with Twitter";
s.polis_err_reg_fb_verification_email_sent = "Please check your email for a verification link, then return here to continue.";
s.polis_err_reg_fb_verification_noemail_unverified = "Your Facebook account is unverified. Please verify your email address with Facebook, then return here to continue.";
s.showTranslationButton = "Show Translation";
s.hideTranslationButton = "Hide Translation";

s.notificationsAlreadySubscribed = "You are subscribed to updates for this conversation.";
s.notificationsGetNotified = "Get notified when more comments arrive:";
s.notificationsEnterEmail = "Enter your email address to get notified when more comments arrive:";
s.labelEmail = "Email";
s.notificationsSubscribeButton = "Subscribe";
s.noCommentsYet = "There aren't any comments yet.";
s.noCommentsYetSoWrite = "Get this conversation started by adding a comment.";
s.noCommentsYetSoInvite = "Get this conversation started by inviting more participants, or add a comment.";
s.noCommentsYouVotedOnAll = "You've voted on all the comments.";
s.noCommentsTryWritingOne = "If you have something to add, try writing your own comment.";
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
