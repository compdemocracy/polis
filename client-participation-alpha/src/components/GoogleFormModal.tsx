interface GoogleFormModalProps {
  isOpen: boolean
  onClose: () => void
}

export default function GoogleFormModal({ isOpen, onClose }: GoogleFormModalProps) {
  if (!isOpen) return null

  const formUrl = import.meta.env.PUBLIC_GOOGLE_FORM_URL

  return (
    <div className="gform-modal-overlay" role="dialog" aria-modal="true">
      <style>{styles}</style>
      <div className="gform-modal">
        <div className="gform-modal-header">
          <h3>시민 포럼 참여 신청</h3>
          <button className="gform-close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <p>
          모든 문항에 응답해 주셔서 감사합니다. 아래 신청서를 작성하고 시민 포럼에 참여해 보세요.
        </p>
        <iframe className="gform-iframe" src={formUrl} title="시민 포럼 참여 신청서" />
        <div className="gform-actions">
          <a
            className="gform-open-new-tab"
            href={formUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            새 탭에서 열기
          </a>
        </div>
      </div>
    </div>
  )
}

const styles = `
.gform-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 16px;
}
.gform-modal {
  background: #fff;
  border-radius: 8px;
  max-width: 640px;
  width: 100%;
  padding: 20px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.2);
}
.gform-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.gform-close {
  border: none;
  background: none;
  font-size: 1.1rem;
  cursor: pointer;
  line-height: 1;
}
.gform-iframe {
  width: 100%;
  height: 60vh;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  margin-top: 8px;
}
.gform-actions {
  margin-top: 12px;
  text-align: right;
}
.gform-open-new-tab {
  color: #0d6efd;
}
`
