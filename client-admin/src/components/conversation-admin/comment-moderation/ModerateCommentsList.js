import { useDispatch } from 'react-redux'
import PropTypes from 'prop-types'
import {
  changeCommentStatusToAccepted,
  changeCommentStatusToRejected,
  changeCommentCommentIsMeta
} from '../../../actions'
import Comment from './Comment'
import Pagination from '../Pagination'

/**
 * Shared component for displaying moderated comments (unmoderated, accepted, or rejected)
 * @param {Object} props
 * @param {Array} props.comments - Array of comments to display
 * @param {Object} props.pagination - Pagination metadata object
 * @param {Function} props.onPageChange - Callback for page changes
 * @param {boolean} props.loading - Loading state
 * @param {string} props.variant - 'unmoderated', 'accepted', or 'rejected'
 * @param {string} props.loadingText - Loading message text
 * @param {string} props.testId - Test ID for the container element
 * @param {number} props.maxComments - Maximum number of comments to display (for unmoderated only)
 */
const ModerateCommentsList = ({
  comments,
  pagination,
  onPageChange,
  loading = false,
  variant,
  loadingText,
  testId,
  maxComments
}) => {
  const dispatch = useDispatch()

  const onCommentAccepted = (comment) => {
    dispatch(changeCommentStatusToAccepted(comment))
  }

  const onCommentRejected = (comment) => {
    dispatch(changeCommentStatusToRejected(comment))
  }

  const toggleIsMetaHandler = (comment, is_meta) => {
    dispatch(changeCommentCommentIsMeta(comment, is_meta))
  }

  const createCommentMarkup = () => {
    // Add safety check to ensure comments is an array
    if (!Array.isArray(comments)) {
      return null
    }

    const commentsToRender = maxComments ? comments.slice(0, maxComments) : comments

    return commentsToRender.map((comment, i) => {
      // Determine which buttons to show based on variant
      const showAcceptButton = variant === 'unmoderated' || variant === 'rejected'
      const showRejectButton = variant === 'unmoderated' || variant === 'accepted'

      return (
        <Comment
          key={i}
          acceptButton={showAcceptButton}
          rejectButton={showRejectButton}
          acceptClickHandler={onCommentAccepted}
          rejectClickHandler={onCommentRejected}
          acceptButtonText="accept"
          rejectButtonText="reject"
          isMetaCheckbox
          toggleIsMetaHandler={toggleIsMetaHandler}
          comment={comment}
        />
      )
    })
  }

  return (
    <div data-testid={testId}>
      {pagination && (
        <Pagination pagination={pagination} onPageChange={onPageChange} loading={loading} />
      )}
      <div>
        {comments !== null && Array.isArray(comments) ? createCommentMarkup() : loadingText}
      </div>
      {pagination && (
        <Pagination pagination={pagination} onPageChange={onPageChange} loading={loading} />
      )}
    </div>
  )
}

ModerateCommentsList.propTypes = {
  comments: PropTypes.array,
  pagination: PropTypes.shape({
    limit: PropTypes.number.isRequired,
    offset: PropTypes.number.isRequired,
    total: PropTypes.number.isRequired,
    hasMore: PropTypes.bool.isRequired
  }),
  onPageChange: PropTypes.func.isRequired,
  loading: PropTypes.bool,
  variant: PropTypes.oneOf(['unmoderated', 'accepted', 'rejected']).isRequired,
  loadingText: PropTypes.string.isRequired,
  testId: PropTypes.string.isRequired,
  maxComments: PropTypes.number
}

export default ModerateCommentsList
