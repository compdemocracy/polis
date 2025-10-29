// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import PolisNet from '../util/net'

/* ======= Types ======= */
export const REQUEST_USER = 'REQUEST_USER'
export const RECEIVE_USER = 'RECEIVE_USER'
export const USER_FETCH_ERROR = 'USER_FETCH_ERROR'

const CREATE_NEW_CONVERSATION = 'CREATE_NEW_CONVERSATION'
const CREATE_NEW_CONVERSATION_SUCCESS = 'CREATE_NEW_CONVERSATION_SUCCESS'
const CREATE_NEW_CONVERSATION_ERROR = 'CREATE_NEW_CONVERSATION_ERROR'

export const REQUEST_CONVERSATIONS = 'REQUEST_CONVERSATIONS'
export const RECEIVE_CONVERSATIONS = 'RECEIVE_CONVERSATIONS'
export const CONVERSATIONS_FETCH_ERROR = 'CONVERSATIONS_FETCH_ERROR'

/* zid for clarity - this is conversation config */
export const REQUEST_CONVERSATION_DATA = 'REQUEST_CONVERSATION_DATA'
export const RECEIVE_CONVERSATION_DATA = 'RECEIVE_CONVERSATION_DATA'
const CONVERSATION_DATA_FETCH_ERROR = 'CONVERSATION_DATA_FETCH_ERROR'
export const CONVERSATION_DATA_RESET = 'CONVERSATION_DATA_RESET'

export const UPDATE_CONVERSATION_DATA_STARTED = 'UPDATE_CONVERSATION_DATA_STARTED'
export const UPDATE_CONVERSATION_DATA_SUCCESS = 'UPDATE_CONVERSATION_DATA_SUCCESS'
export const UPDATE_CONVERSATION_DATA_ERROR = 'UPDATE_CONVERSATION_DATA_ERROR'

export const OPTIMISTIC_CONVERSATION_DATA_UPDATE = 'OPTIMISTIC_CONVERSATION_DATA_UPDATE'

/* moderation */
export const REQUEST_COMMENTS = 'REQUEST_COMMENTS'
export const RECEIVE_COMMENTS = 'RECEIVE_COMMENTS'
export const COMMENTS_FETCH_ERROR = 'COMMENTS_FETCH_ERROR'

export const REQUEST_UNMODERATED_COMMENTS = 'REQUEST_UNMODERATED_COMMENTS'
export const RECEIVE_UNMODERATED_COMMENTS = 'RECEIVE_UNMODERATED_COMMENTS'
const UNMODERATED_COMMENTS_FETCH_ERROR = 'UNMODERATED_COMMENTS_FETCH_ERROR'

export const REQUEST_ACCEPTED_COMMENTS = 'REQUEST_ACCEPTED_COMMENTS'
export const RECEIVE_ACCEPTED_COMMENTS = 'RECEIVE_ACCEPTED_COMMENTS'
const ACCEPTED_COMMENTS_FETCH_ERROR = 'ACCEPTED_COMMENTS_FETCH_ERROR'

export const REQUEST_REJECTED_COMMENTS = 'REQUEST_REJECTED_COMMENTS'
export const RECEIVE_REJECTED_COMMENTS = 'RECEIVE_REJECTED_COMMENTS'
const REJECTED_COMMENTS_FETCH_ERROR = 'REJECTED_COMMENTS_FETCH_ERROR'

const ACCEPT_COMMENT = 'ACCEPT_COMMENT'
const ACCEPT_COMMENT_SUCCESS = 'ACCEPT_COMMENT_SUCCESS'
const ACCEPT_COMMENT_ERROR = 'ACCEPT_COMMENT_ERROR'

const REJECT_COMMENT = 'REJECT_COMMENT'
const REJECT_COMMENT_SUCCESS = 'REJECT_COMMENT_SUCCESS'
const REJECT_COMMENT_ERROR = 'REJECT_COMMENT_ERROR'

const COMMENT_IS_META = 'COMMENT_IS_META'
const COMMENT_IS_META_SUCCESS = 'COMMENT_IS_META_SUCCESS'
const COMMENT_IS_META_ERROR = 'COMMENT_IS_META_ERROR'

/* submit seed comment */
export const SEED_COMMENT_LOCAL_UPDATE = 'SEED_COMMENT_LOCAL_UPDATE'
export const SUBMIT_SEED_COMMENT = 'SUBMIT_SEED_COMMENT'
export const SUBMIT_SEED_COMMENT_SUCCESS = 'SUBMIT_SEED_COMMENT_SUCCESS'
export const SUBMIT_SEED_COMMENT_ERROR = 'SUBMIT_SEED_COMMENT_ERROR'

/* conversation stats */
export const REQUEST_CONVERSATION_STATS = 'REQUEST_CONVERSATION_STATS'
export const RECEIVE_CONVERSATION_STATS = 'RECEIVE_CONVERSATION_STATS'
const CONVERSATION_STATS_FETCH_ERROR = 'CONVERSATION_STATS_FETCH_ERROR'

/* ======= Actions ======= */

/*

  populate is the function the component calls
  fetch is the api call itself
  request tells everyone we"re loading
  receive proxies the data to the store

*/

/* User */

const requestUser = () => {
  return {
    type: REQUEST_USER
  }
}

const receiveUser = (data) => {
  return {
    type: RECEIVE_USER,
    data: data
  }
}

const userFetchError = (err) => {
  return {
    type: USER_FETCH_ERROR,
    status: err.status,
    data: err
  }
}

const fetchUser = () => {
  return PolisNet.polisGet('/api/v3/users')
}

export const populateUserStore = () => {
  return (dispatch) => {
    dispatch(requestUser())
    return fetchUser().then(
      (res) => dispatch(receiveUser(res)),
      (err) => dispatch(userFetchError(err))
    )
  }
}

/* Conversations */

const requestConversations = () => {
  return {
    type: REQUEST_CONVERSATIONS
  }
}

const receiveConversations = (data) => {
  return {
    type: RECEIVE_CONVERSATIONS,
    data: data
  }
}

const conversationsError = (err) => {
  return {
    type: CONVERSATIONS_FETCH_ERROR,
    data: err
  }
}

const fetchConversations = () => {
  return PolisNet.polisGet('/api/v3/conversations', {
    include_all_conversations_i_am_in: true
  })
}

export const populateConversationsStore = () => {
  return (dispatch) => {
    dispatch(requestConversations())
    return fetchConversations().then(
      (res) => dispatch(receiveConversations(res)),
      (err) => dispatch(conversationsError(err))
    )
  }
}

/* conversation data */

const requestConversationData = (conversation_id) => {
  return {
    type: REQUEST_CONVERSATION_DATA,
    data: {
      conversation_id: conversation_id
    }
  }
}

const receiveConversationData = (data) => {
  return {
    type: RECEIVE_CONVERSATION_DATA,
    data: data
  }
}

const conversationDataFetchError = (err) => {
  return {
    type: CONVERSATION_DATA_FETCH_ERROR,
    data: err
  }
}

export const resetMetadataStore = () => {
  return {
    type: CONVERSATION_DATA_RESET
  }
}

const fetchConversationData = (conversation_id) => {
  return PolisNet.polisGet('/api/v3/conversations', {
    conversation_id: conversation_id
  })
}

export const populateConversationDataStore = (conversation_id) => {
  return (dispatch, getState) => {
    const state = getState()
    const { loading, conversation_id: current_conversation_id } = state.conversationData

    // NOTE: if there are multiple calls outstanding this may be wrong.
    const isLoadingThisConversation = current_conversation_id === conversation_id && loading

    if (isLoadingThisConversation) {
      return
    }

    // don't fetch again if we already have data loaded for that conversation.
    if (current_conversation_id === conversation_id) {
      return
    }

    dispatch(requestConversationData(conversation_id))
    return fetchConversationData(conversation_id).then(
      (res) => dispatch(receiveConversationData(res)),
      (err) => dispatch(conversationDataFetchError(err))
    )
  }
}

/* conversation data update */

const updateConversationDataStarted = () => {
  return {
    type: UPDATE_CONVERSATION_DATA_STARTED
  }
}

const updateConversationDataSuccess = (data) => {
  return {
    type: UPDATE_CONVERSATION_DATA_SUCCESS,
    data: data
  }
}

const updateConversationDataError = (err) => {
  return {
    type: UPDATE_CONVERSATION_DATA_ERROR,
    data: err
  }
}

const updateConversationData = (conversationData, field, value) => {
  const data = {}
  data[field] = value
  const bodyData = Object.assign({}, conversationData, data)

  return PolisNet.polisPut('/api/v3/conversations', bodyData)
}

export const handleConversationDataUpdate = (conversationData, field, value) => {
  return (dispatch) => {
    dispatch(updateConversationDataStarted())
    return updateConversationData(conversationData, field, value)
      .then((res) => dispatch(updateConversationDataSuccess(res)))
      .catch((err) => dispatch(updateConversationDataError(err)))
  }
}

export const optimisticConversationDataUpdateOnTyping = (conversationData, field, value) => {
  const nextZm = {
    ...conversationData,
    [field]: value
  }
  return {
    type: OPTIMISTIC_CONVERSATION_DATA_UPDATE,
    data: nextZm
  }
}

/* seed comments submit */

export const seedCommentChanged = (text) => {
  return {
    type: SEED_COMMENT_LOCAL_UPDATE,
    text: text
  }
}

const submitSeedCommentStart = () => {
  return {
    type: SUBMIT_SEED_COMMENT
  }
}

const submitSeedCommentPostSuccess = () => {
  return {
    type: SUBMIT_SEED_COMMENT_SUCCESS
  }
}

const submitSeedCommentPostError = (err) => {
  return {
    type: SUBMIT_SEED_COMMENT_ERROR,
    data: err
  }
}

const postSeedComment = (comment) => {
  return PolisNet.polisPost('/api/v3/comments', comment)
}

const postBulkSeedComments = (commentsCSV) => {
  return PolisNet.polisPost('/api/v3/comments-bulk', commentsCSV)
}

export const handleBulkSeedCommentSubmit = (commentsCSV) => {
  return (dispatch) => {
    dispatch(submitSeedCommentStart())
    return postBulkSeedComments(commentsCSV).then(
      (res) => dispatch(submitSeedCommentPostSuccess(res)),
      (err) => dispatch(submitSeedCommentPostError(err))
    )
  }
}

export const handleSeedCommentSubmit = (comment) => {
  return (dispatch) => {
    dispatch(submitSeedCommentStart())
    return postSeedComment(comment)
      .then(
        (res) => dispatch(submitSeedCommentPostSuccess(res)),
        (err) => dispatch(submitSeedCommentPostError(err))
      )
      .then(dispatch(populateAllCommentStores(comment.conversation_id)))
  }
}

/* create conversation */

const createConversationStart = () => {
  return {
    type: CREATE_NEW_CONVERSATION
  }
}

const createConversationPostSuccess = (res) => {
  return {
    type: CREATE_NEW_CONVERSATION_SUCCESS,
    data: res
  }
}

const createConversationPostError = (err) => {
  return {
    type: CREATE_NEW_CONVERSATION_ERROR,
    data: err
  }
}

const postCreateConversation = () => {
  return PolisNet.polisPost('/api/v3/conversations', {
    is_draft: true,
    is_active: true
  })
}

export const handleCreateConversationSubmit = (history) => {
  return (dispatch) => {
    dispatch(createConversationStart())
    return postCreateConversation()
      .then(
        (res) => {
          dispatch(createConversationPostSuccess(res))
          return res
        },
        (err) => dispatch(createConversationPostError(err))
      )
      .then((res) => {
        if (history && history.push) {
          // Use React Router navigation to avoid full page reload
          history.push('/m/' + res.conversation_id)
        } else {
          // Fallback to window.location if history is not available
          window.location = '/m/' + res.conversation_id
        }
      })
  }
}

/* moderation comments - unified implementation */

// Helper function to create action creators for moderation types
const createModerationActions = (requestType, receiveType, errorType) => {
  const request = () => ({ type: requestType })
  const receive = (data) => ({ type: receiveType, data })
  const error = (err) => ({ type: errorType, data: err })
  return { request, receive, error }
}

// Unified fetch function for all moderation types
const fetchModeratedComments = (conversation_id, mod, limit = 50, offset = 0) => {
  let url = `/api/v3/comments?moderation=true&include_voting_patterns=false&mod=${mod}&conversation_id=${conversation_id}`

  // Add pagination parameters if limit is provided
  if (limit) {
    url += `&limit=${limit}&offset=${offset}`
  }

  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch(url, {
      method: 'GET',
      headers: {
        ...(token && { Authorization: `Bearer ${token}` })
      }
    }).then((r) => r.json())
  )
}

// Create action creators for each moderation type
const unmoderatedActions = createModerationActions(
  REQUEST_UNMODERATED_COMMENTS,
  RECEIVE_UNMODERATED_COMMENTS,
  UNMODERATED_COMMENTS_FETCH_ERROR
)

const acceptedActions = createModerationActions(
  REQUEST_ACCEPTED_COMMENTS,
  RECEIVE_ACCEPTED_COMMENTS,
  ACCEPTED_COMMENTS_FETCH_ERROR
)

const rejectedActions = createModerationActions(
  REQUEST_REJECTED_COMMENTS,
  RECEIVE_REJECTED_COMMENTS,
  REJECTED_COMMENTS_FETCH_ERROR
)

// Unified populate function factory
const createPopulateModerationStore = (actions, mod) => {
  return (conversation_id, limit = 50, offset = 0) => {
    return (dispatch) => {
      dispatch(actions.request())
      return fetchModeratedComments(conversation_id, mod, limit, offset).then(
        (res) => dispatch(actions.receive(res)),
        (err) => dispatch(actions.error(err))
      )
    }
  }
}

/* unmoderated comments */
export const populateUnmoderatedCommentsStore = createPopulateModerationStore(unmoderatedActions, 0)

/* accepted comments */
export const populateAcceptedCommentsStore = createPopulateModerationStore(acceptedActions, 1)

/* rejected comments */
const populateRejectedCommentsStore = createPopulateModerationStore(rejectedActions, -1)

/* populate ALL stores todo/accept/reject/seed */

export const populateAllCommentStores = (conversation_id, limit = 50, offset = 0) => {
  return (dispatch) => {
    return Promise.all([
      dispatch(populateUnmoderatedCommentsStore(conversation_id, limit, offset)),
      dispatch(populateAcceptedCommentsStore(conversation_id, limit, offset)),
      dispatch(populateRejectedCommentsStore(conversation_id, limit, offset))
    ])
  }
}

/* moderator clicked accept comment */

const optimisticCommentAccepted = (comment) => {
  return {
    type: ACCEPT_COMMENT,
    comment: comment
  }
}

const acceptCommentSuccess = (data) => {
  return {
    type: ACCEPT_COMMENT_SUCCESS,
    data: data
  }
}

const acceptCommentError = (err) => {
  return {
    type: ACCEPT_COMMENT_ERROR,
    data: err
  }
}

const putCommentAccepted = (comment) => {
  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch('/api/v3/comments', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` })
      },
      body: JSON.stringify(Object.assign(comment, { mod: 1 }))
    }).then((r) => r.json())
  )
}

export const changeCommentStatusToAccepted = (comment) => {
  comment.active = true
  return (dispatch) => {
    dispatch(optimisticCommentAccepted(comment))
    return putCommentAccepted(comment).then(
      (res) => {
        dispatch(acceptCommentSuccess(res))
        dispatch(populateAllCommentStores(comment.conversation_id))
      },
      (err) => dispatch(acceptCommentError(err))
    )
  }
}

/* moderator clicked reject comment */

const optimisticCommentRejected = (comment) => {
  return {
    type: REJECT_COMMENT,
    comment: comment
  }
}

const rejectCommentSuccess = (data) => {
  return {
    type: REJECT_COMMENT_SUCCESS,
    data: data
  }
}

const rejectCommentError = (err) => {
  return {
    type: REJECT_COMMENT_ERROR,
    data: err
  }
}

const putCommentRejected = (comment) => {
  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch('/api/v3/comments', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` })
      },
      body: JSON.stringify(Object.assign(comment, { mod: -1 }))
    }).then((r) => r.json())
  )
}

export const changeCommentStatusToRejected = (comment) => {
  return (dispatch) => {
    dispatch(optimisticCommentRejected())
    return putCommentRejected(comment).then(
      (res) => {
        dispatch(rejectCommentSuccess(res))
        dispatch(populateAllCommentStores(comment.conversation_id))
      },
      (err) => dispatch(rejectCommentError(err))
    )
  }
}

/* moderator changed comment's is_meta flag */

const optimisticCommentIsMetaChanged = (comment) => {
  return {
    type: COMMENT_IS_META,
    comment: comment
  }
}

const commentIsMetaChangeSuccess = (data) => {
  return {
    type: COMMENT_IS_META_SUCCESS,
    data: data
  }
}

const commentIsMetaChangeError = (err) => {
  return {
    type: COMMENT_IS_META_ERROR,
    data: err
  }
}

const putCommentCommentIsMetaChange = (comment, is_meta) => {
  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch('/api/v3/comments', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` })
      },
      body: JSON.stringify(Object.assign(comment, { is_meta: is_meta }))
    }).then((r) => r.json())
  )
}

export const changeCommentCommentIsMeta = (comment, is_meta) => {
  return (dispatch) => {
    dispatch(optimisticCommentIsMetaChanged())
    return putCommentCommentIsMetaChange(comment, is_meta).then(
      (res) => {
        dispatch(commentIsMetaChangeSuccess(res))
        dispatch(populateAllCommentStores(comment.conversation_id))
      },
      (err) => dispatch(commentIsMetaChangeError(err))
    )
  }
}

/* request conversation stats */

const requestConversationStats = () => {
  return {
    type: REQUEST_CONVERSATION_STATS
  }
}

const receiveConversationStats = (data) => {
  return {
    type: RECEIVE_CONVERSATION_STATS,
    data: data
  }
}

const conversationStatsFetchError = (err) => {
  return {
    type: CONVERSATION_STATS_FETCH_ERROR,
    data: err
  }
}

const fetchConversationStats = (conversation_id, until) => {
  let url = `/api/v3/conversationStats?conversation_id=${conversation_id}`
  if (until) {
    url += `&until=${until}`
  }

  return PolisNet.polisGet(url)
}

export const populateConversationStatsStore = (conversation_id, until) => {
  return (dispatch) => {
    dispatch(requestConversationStats())
    return fetchConversationStats(conversation_id, until).then(
      (res) => dispatch(receiveConversationStats(res)),
      (err) => dispatch(conversationStatsFetchError(err))
    )
  }
}
