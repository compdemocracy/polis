/**
 * Factory function to create moderation reducers for unmoderated, accepted, or rejected comments
 * @param {string} requestType - Action type for request (e.g., REQUEST_UNMODERATED_COMMENTS)
 * @param {string} receiveType - Action type for receive (e.g., RECEIVE_UNMODERATED_COMMENTS)
 * @param {string} commentsKey - Key name for comments in state (e.g., 'unmoderated_comments')
 * @returns {Function} Redux reducer function
 */
const createModerationReducer = (requestType, receiveType, commentsKey) => {
  return (
    state = {
      loading: false,
      [commentsKey]: null,
      pagination: null
    },
    action
  ) => {
    switch (action.type) {
      case requestType:
        return Object.assign({}, state, {
          loading: true
        })
      case receiveType:
        // Handle both legacy array format and new paginated format
        if (Array.isArray(action.data)) {
          // Legacy format - no pagination
          return Object.assign({}, state, {
            loading: false,
            [commentsKey]: action.data,
            pagination: null
          })
        } else {
          // New paginated format
          return Object.assign({}, state, {
            loading: false,
            [commentsKey]: action.data.comments || [],
            pagination: action.data.pagination || null
          })
        }
      default:
        return state
    }
  }
}

export default createModerationReducer
