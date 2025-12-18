import type { Translations } from "./types"

const s: Partial<Translations> = {}

// ─────────────────────────────────────────────────────────────
// General UI
// ─────────────────────────────────────────────────────────────
s.privacy = "Quyền riêng tư"
s.TOS = "Điều khoản dịch vụ"

// ─────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────
s.convIsClosed = "Cuộc thảo luận này đã kết thúc."
s.participantHelpWelcomeText =
  "Xin giới thiệu một hình thức thảo luận mới: <em>bình chọn</em> cho ý kiến của người khác – càng nhiều càng tốt!"

// ─────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────
s.agree = "Đồng ý"
s.disagree = "Không đồng ý"
s.pass = "Bỏ qua / Không rõ"

// ─────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────
s.anonPerson = "Ẩn danh"
s.comments_remaining = "Còn lại {{num_comments}}"
s.importantCheckbox = "Quan trọng / Có ý nghĩa"
s.importantCheckboxDesc =
  "Đánh dấu vào ô này nếu bạn cho rằng ý kiến này đặc biệt quan trọng đối với bạn hoặc có ý nghĩa đáng kể với nội dung thảo luận, bất kể bạn bình chọn ra sao. Khi phân tích nội dung thảo luận, ý kiến này sẽ được ưu tiên hơn so với các ý kiến khác bạn bình chọn."
s.x_wrote = "đã viết:"

// ─────────────────────────────────────────────────────────────
// Writing statements
// ─────────────────────────────────────────────────────────────
s.commentErrorConversationClosed =
  "Cuộc thảo luận này đã kết thúc. Bạn không gửi thêm ý kiến được nữa."
s.commentErrorDuplicate = "Trùng lặp! Ý kiến đó đã có từ trước."
s.commentSendFailed = "Đã xảy ra lỗi khi gửi ý kiến của bạn."
s.commentSent =
  "Đã gửi ý kiến! Chỉ những người tham gia khác mới có thể nhìn thấy và đồng ý hoặc không đồng ý với ý kiến của bạn."
s.helpWriteListIntro = "Thế nào là một ý kiến phù hợp?"
s.helpWriteListRaisNew = "Một quan điểm, trải nghiệm hoặc vấn đề mới"
s.helpWriteListShort = "Cách viết ngắn gọn và rõ ràng (tối đa 140 ký tự)"
s.helpWriteListStandalone = "Một ý tưởng độc lập"
s.submitComment = "Gửi"
s.tipCommentsRandom =
  "Ý kiến sẽ xuất hiện ngẫu nhiên. Bạn không trực tiếp phản hồi ý kiến của người khác, <b> mà cần phát biểu ý kiến độc lập.<b>"
s.writePrompt =
  "Chia sẻ quan điểm của bạn (phần này không phải để phản hồi ý kiến của người khác — hãy gửi ý kiến độc lập)"
s.writeCommentHelpText =
  "Có phải quan điểm hoặc trải nghiệm của bạn chưa có trong nội dung thảo luận? Nếu đúng vậy, </b>hãy thêm ý kiến </b> vào ô bên dưới – </b>mỗi lần một câu</b>."

// ─────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────
s.comment_123 = "Ý kiến:"
s.group_123 = "Nhóm:"
s.opinionGroups = "Các nhóm quan điểm"
s.pctAgreedLong = "{{pct}}% số người bình chọn cho ý kiến {{comment_id}} đồng ý."
s.pctAgreedOfGroupLong =
  "{{pct}}% số người thuộc nhóm {{group}} và bình chọn cho ý kiến {{comment_id}} đồng ý."
s.pctDisagreedLong = "{{pct}}% số người bình chọn cho ý kiến {{comment_id}} không đồng ý."
s.pctDisagreedOfGroupLong =
  "{{pct}}% số người thuộc nhóm {{group}} và bình chọn cho ý kiến {{comment_id}} không đồng ý."

// ─────────────────────────────────────────────────────────────
// Topics (Delphi)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Invites (Treevite)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────
s.notificationsAlreadySubscribed = "Bạn đã đăng ký nhận tin cập nhật về cuộc thảo luận này."
s.notificationsGetNotified = "Nhận thông báo khi có thêm ý kiến:"
s.notificationsEnterEmail = "Nhập địa chỉ email của bạn để nhận thông báo khi có thêm ý kiến:"
s.notificationsSubscribeButton = "Đăng ký"

// ─────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────
s.showTranslationButton = "Bật bản dịch của bên thứ ba"
s.hideTranslationButton = "Tắt bản dịch"

// ─────────────────────────────────────────────────────────────
// Authentication / XID
// ─────────────────────────────────────────────────────────────

export default s
