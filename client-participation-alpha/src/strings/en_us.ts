import type { Translations } from "./types"

const s: Translations = {
  // ─────────────────────────────────────────────────────────────
  // General UI
  // ─────────────────────────────────────────────────────────────
  closed: "closed",
  copied: "Copied",
  copy: "Copy",
  dismissWarning: "Dismiss warning",
  error: "Error",
  loading: "Loading...",
  ok_got_it: "OK, got it",
  oops: "Oops!",
  or_text: "or",
  privacy: "Privacy",
  submitting: "Submitting...",
  TOS: "TOS",

  // ─────────────────────────────────────────────────────────────
  // Conversation
  // ─────────────────────────────────────────────────────────────
  convIsClosed: "This conversation is closed.",
  couldNotLoadConversation:
    "Could not load this conversation. Error: {{error}}. Please check the ID and try again.",
  participantHelpWelcomeText:
    "Welcome to a new kind of conversation — </b>vote</b> on other people’s statements — </b> the more the better.</b>",
  signInToParticipate: "You need to sign in to participate.",

  // ─────────────────────────────────────────────────────────────
  // Voting
  // ─────────────────────────────────────────────────────────────
  agree: "Agree",
  disagree: "Disagree",
  pass: "Pass / Unsure",
  signInToVote: "You need to sign in to vote.",
  voteFailedGeneric:
    "Apologies, your vote failed to send. Please check your connection and try again.",

  // ─────────────────────────────────────────────────────────────
  // Statements
  // ─────────────────────────────────────────────────────────────
  anonPerson: "Anonymous",
  comments_remaining: "{{num_comments}} remaining",
  importantCheckbox: "Important/Significant",
  importantCheckboxDesc:
    "Check this box if you believe this statement is especially important to you or is highly relevant to the conversation, irrespective of your vote. It will give this statement higher priority compared to your other votes in the conversation analysis.",
  infoIconAriaLabel: "More information about importance",
  x_wrote: "wrote:",

  // ─────────────────────────────────────────────────────────────
  // Writing statements
  // ─────────────────────────────────────────────────────────────
  commentErrorConversationClosed:
    "This conversation is closed. No further statements can be submitted.",
  commentErrorDuplicate: "Duplicate! That statement already exists.",
  commentSendFailed: "There was an error submitting your statement.",
  commentSent:
    "Statement submitted! Only other participants will see your statement and agree or disagree.",
  helpWriteListIntro: "What makes for a good statement?",
  helpWriteListRaisNew: "A new perspective, experience, or issue",
  helpWriteListShort: "Clear & concise wording (limited to 140 characters)",
  helpWriteListStandalone: "A stand-alone idea",
  submitComment: "Submit",
  tipCommentsRandom:
    "Statements are displayed randomly and you are not replying directly to other people’s statements: <b> you are adding a stand-alone statement.<b>",
  writePrompt: "Share your perspective (you are not replying — submit a stand-alone statement)",
  writeCommentHelpText:
    "Are your perspectives or experiences missing from the conversation? If so, </b>add them </b> in the box below — </b>one at a time</b>.",

  // ─────────────────────────────────────────────────────────────
  // Visualization
  // ─────────────────────────────────────────────────────────────
  comment_123: "Statement:",
  consensus: "Consensus",
  group_123: "Group:",
  opinionGroups: "Opinion Groups",
  pctAgreedLong: "{{pct}}% of everyone who voted on statement {{comment_id}} agreed.",
  pctAgreedOfGroupLong:
    "{{pct}}% of those in group {{group}} who voted on statement {{comment_id}} agreed.",
  pctDisagreedLong: "{{pct}}% of everyone who voted on statement {{comment_id}} disagreed.",
  pctDisagreedOfGroupLong:
    "{{pct}}% of those in group {{group}} who voted on statement {{comment_id}} disagreed.",

  // ─────────────────────────────────────────────────────────────
  // Topics (Delphi)
  // ─────────────────────────────────────────────────────────────
  doneWithCount: "Done ({{count}} selected)",
  failedToSaveTopicSelections: "Failed to save topic selections. Please try again.",
  moreSpecificTopics: "More Specific Topics",
  selectTopics: "Select Topics",
  superSpecificTopics: "SUPER SPECIFIC TOPICS",
  topicSelectionsSavedSuccess: "Topic selections saved successfully!",

  // ─────────────────────────────────────────────────────────────
  // Invites (Treevite)
  // ─────────────────────────────────────────────────────────────
  download_invites_csv: "Download CSV",
  invite_code_accepted_message:
    "Invite accepted. Your login code is: {{login_code}}. Treat this code like a password — save it in a secure place. You must use it to log in again later. It cannot be re-issued if lost.",
  invite_code_accepted_message_no_code: "Invite accepted.",
  invite_code_invalid: "The provided invite code was invalid. Please try again.",
  invite_code_prompt: "Enter Invite Code",
  invite_code_required_long: "An invite code is required to participate in this conversation",
  invite_code_required_short: "Invite Code Required",
  invite_status_expired: "expired",
  invite_status_revoked: "revoked",
  invite_status_unused: "unused",
  invite_status_used: "used",
  invites_instructions: "Copy and share these invite codes to invite new participants:",
  invites_link: "Invites",
  invites_none: "You don’t have any invites yet.",
  invites_wave_sentence: "You are in wave {{wave}}. Joined {{date}}",
  login_code_invalid: "The provided login code was invalid. Please try again.",
  login_code_prompt: "Enter Login Code",
  login_success: "Success! You are now logged in.",
  submit_invite_code: "Submit Invite Code",
  submit_login_code: "Submit Login Code",

  // ─────────────────────────────────────────────────────────────
  // Notifications
  // ─────────────────────────────────────────────────────────────
  notificationsAlreadySubscribed: "You are subscribed to updates for this conversation.",
  notificationsEnterEmail: "Enter your email address to get notified when more statements arrive:",
  notificationsGetNotified: "Get notified when more statements arrive:",
  notificationsSubscribeButton: "Subscribe",
  notificationsSubscribeErrorGeneric: "Sorry, we couldn’t subscribe you. Please try again later.",

  // ─────────────────────────────────────────────────────────────
  // Translation
  // ─────────────────────────────────────────────────────────────
  hideTranslationButton: "Deactivate Translation",
  showTranslationButton: "Activate third-party translation",

  // ─────────────────────────────────────────────────────────────
  // Authentication / XID
  // ─────────────────────────────────────────────────────────────
  xidOidcConflictWarning:
    "Warning: You are currently signed-in to polis, but have opened a conversation with an XID token. To participate with an XID, please log out of your polis account.",
  xidRequired:
    "This conversation requires an XID (external identifier) to participate. Please use the proper link provided to you."
}

export default s
