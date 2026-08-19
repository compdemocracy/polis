import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.closed = "종료됨"
s.copied = "복사됨"
s.copy = "복사"
s.dismissWarning = "경고 닫기"
s.error = "오류"
s.loading = "불러오는 중..."
s.ok_got_it = "확인했습니다"
s.oops = "문제가 발생했습니다"
s.or_text = "또는"
s.privacy = "개인정보처리방침"
s.submitting = "제출 중..."
s.TOS = "이용약관"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "이 대화는 종료되었습니다."
s.couldNotLoadConversation =
  "대화를 불러오지 못했습니다. 오류: {{error}}. ID를 확인 후 다시 시도해 주세요."
s.signInToParticipate = "참여하려면 로그인이 필요합니다."

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "찬성"
s.disagree = "반대"
s.pass = "패스"
s.signInToVote = "투표하려면 로그인이 필요합니다."
s.voteFailedGeneric =
  "죄송합니다, 투표 전송에 실패했습니다. 연결 상태를 확인 후 다시 시도해 주세요."

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "익명"
s.comments_remaining = "{{num_comments}}개 남음"
s.importantCheckbox = "중요/의미 있음"
s.importantCheckboxDesc =
  "이 문장이 특별히 중요하거나 대화와 매우 관련이 높다고 생각되면 체크해 주세요. 분석 시 다른 투표보다 높은 우선순위로 반영됩니다."
s.infoIconAriaLabel = "중요도에 대한 추가 정보"
s.x_wrote = "님이 작성:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorConversationClosed = "이 대화는 종료되어 더 이상 의견을 제출할 수 없습니다."
s.commentErrorDuplicate = "이미 동일한 의견이 존재합니다."
s.commentSendFailed = "의견 제출 중 오류가 발생했습니다."
s.commentSent = "의견이 제출되었습니다! 다른 참여자들이 이 의견에 찬성/반대할 수 있습니다."
s.helpWriteListIntro = "좋은 의견이란?"
s.helpWriteListRaisNew = "새로운 관점, 경험 또는 쟁점"
s.helpWriteListShort = "명확하고 간결한 문장 (140자 이내)"
s.helpWriteListStandalone = "독립적으로 이해 가능한 하나의 생각"
s.submitComment = "보내기"
s.tipCommentsRandom =
  "의견은 무작위로 표시되며 다른 사람의 의견에 답글을 다는 것이 아닙니다: <b>독립된 새 의견을 추가하는 것입니다.</b>"
s.writePrompt = "새로운 질문이 생겼다면 적어 주세요."
s.writeCommentHelpText =
  "빠진 관점이나 경험이 있다면 아래 입력창에 <b>한 번에 하나씩</b> 추가해 주세요."

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "의견:"
s.consensus = "합의"
s.group_123 = "그룹:"
s.opinionGroups = "의견 그룹"
s.pctAgreedLong = "의견 {{comment_id}}에 투표한 사람 중 {{pct}}%가 찬성했습니다."
s.pctAgreedOfGroupLong =
  "그룹 {{group}}에서 의견 {{comment_id}}에 투표한 사람 중 {{pct}}%가 찬성했습니다."
s.pctDisagreedLong = "의견 {{comment_id}}에 투표한 사람 중 {{pct}}%가 반대했습니다."
s.pctDisagreedOfGroupLong =
  "그룹 {{group}}에서 의견 {{comment_id}}에 투표한 사람 중 {{pct}}%가 반대했습니다."

// ─────────────────────────────────────────────────────────────
// Topics (Delphi)
// ─────────────────────────────────────────────────────────────
s.doneWithCount = "완료 ({{count}}개 선택됨)"
s.failedToSaveTopicSelections = "주제 선택 저장에 실패했습니다. 다시 시도해 주세요."
s.moreSpecificTopics = "더 구체적인 주제"
s.selectTopics = "주제 선택"
s.superSpecificTopics = "매우 구체적인 주제"
s.topicSelectionsSavedSuccess = "주제 선택이 저장되었습니다!"

// ─────────────────────────────────────────────────────────────
// Invites (Treevite)
// ─────────────────────────────────────────────────────────────
s.invite_code_invalid = "초대 코드가 올바르지 않습니다. 다시 시도해 주세요."
s.invite_code_prompt = "초대 코드 입력"
s.invite_code_required_long = "이 대화에 참여하려면 초대 코드가 필요합니다."
s.invite_code_required_short = "초대 코드 필요"
s.login_code_invalid = "로그인 코드가 올바르지 않습니다. 다시 시도해 주세요."
s.login_code_prompt = "로그인 코드 입력"
s.login_success = "로그인되었습니다."
s.submit_invite_code = "초대 코드 제출"
s.submit_login_code = "로그인 코드 제출"

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────
s.notificationsAlreadySubscribed = "이 대화의 알림을 구독 중입니다."
s.notificationsEnterEmail = "새로운 의견이 등록되면 알림을 받을 이메일 주소를 입력하세요:"
s.notificationsGetNotified = "새로운 의견이 등록되면 알림 받기:"
s.notificationsSubscribeButton = "구독"
s.notificationsSubscribeErrorGeneric =
  "죄송합니다, 구독에 실패했습니다. 잠시 후 다시 시도해 주세요."

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────
s.hideTranslationButton = "번역 끄기"
s.showTranslationButton = "번역 보기"

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────
s.xidOidcConflictWarning =
  "경고: 현재 polis 계정으로 로그인되어 있지만 XID 토큰으로 대화를 열었습니다. XID로 참여하려면 polis 계정에서 로그아웃해 주세요."
s.xidRequired = "이 대화에 참여하려면 XID(외부 식별자)가 필요합니다. 제공받은 링크를 이용해 주세요."

export default s
