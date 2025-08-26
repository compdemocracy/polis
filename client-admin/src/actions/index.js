// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import PolisNet from '../util/net'

/* ======= Types ======= */
export const REQUEST_USER = 'REQUEST_USER'
export const RECEIVE_USER = 'RECEIVE_USER'
export const USER_FETCH_ERROR = 'USER_FETCH_ERROR'

export const CREATE_NEW_CONVERSATION = 'CREATE_NEW_CONVERSATION'
export const CREATE_NEW_CONVERSATION_SUCCESS = 'CREATE_NEW_CONVERSATION_SUCCESS'
export const CREATE_NEW_CONVERSATION_ERROR = 'CREATE_NEW_CONVERSATION_ERROR'

export const REQUEST_CONVERSATIONS = 'REQUEST_CONVERSATIONS'
export const RECEIVE_CONVERSATIONS = 'RECEIVE_CONVERSATIONS'
export const CONVERSATIONS_FETCH_ERROR = 'CONVERSATIONS_FETCH_ERROR'

/* zid for clarity - this is conversation config */
export const REQUEST_ZID_METADATA = 'REQUEST_ZID_METADATA'
export const RECEIVE_ZID_METADATA = 'RECEIVE_ZID_METADATA'
export const ZID_METADATA_FETCH_ERROR = 'ZID_METADATA_FETCH_ERROR'
export const ZID_METADATA_RESET = 'ZID_METADATA_RESET'

export const UPDATE_ZID_METADATA_STARTED = 'UPDATE_ZID_METADATA_STARTED'
export const UPDATE_ZID_METADATA_SUCCESS = 'UPDATE_ZID_METADATA_SUCCESS'
export const UPDATE_ZID_METADATA_ERROR = 'UPDATE_ZID_METADATA_ERROR'

export const OPTIMISTIC_ZID_METADATA_UPDATE = 'OPTIMISTIC_ZID_METADATA_UPDATE'

/* report */
export const UPDATE_REPORT_STARTED = 'UPDATE_REPORT_STARTED'
export const UPDATE_REPORT_SUCCESS = 'UPDATE_REPORT_SUCCESS'
export const UPDATE_REPORT_ERROR = 'UPDATE_REPORT_ERROR'

export const OPTIMISTIC_REPORT_UPDATE = 'OPTIMISTIC_REPORT_UPDATE'

/* moderation */
export const REQUEST_COMMENTS = 'REQUEST_COMMENTS'
export const RECEIVE_COMMENTS = 'RECEIVE_COMMENTS'
export const COMMENTS_FETCH_ERROR = 'COMMENTS_FETCH_ERROR'

export const REQUEST_UNMODERATED_COMMENTS = 'REQUEST_UNMODERATED_COMMENTS'
export const RECEIVE_UNMODERATED_COMMENTS = 'RECEIVE_UNMODERATED_COMMENTS'
export const UNMODERATED_COMMENTS_FETCH_ERROR = 'UNMODERATED_COMMENTS_FETCH_ERROR'

export const REQUEST_ACCEPTED_COMMENTS = 'REQUEST_ACCEPTED_COMMENTS'
export const RECEIVE_ACCEPTED_COMMENTS = 'RECEIVE_ACCEPTED_COMMENTS'
export const ACCEPTED_COMMENTS_FETCH_ERROR = 'ACCEPTED_COMMENTS_FETCH_ERROR'

export const REQUEST_REJECTED_COMMENTS = 'REQUEST_REJECTED_COMMENTS'
export const RECEIVE_REJECTED_COMMENTS = 'RECEIVE_REJECTED_COMMENTS'
export const REJECTED_COMMENTS_FETCH_ERROR = 'REJECTED_COMMENTS_FETCH_ERROR'

export const ACCEPT_COMMENT = 'ACCEPT_COMMENT'
export const ACCEPT_COMMENT_SUCCESS = 'ACCEPT_COMMENT_SUCCESS'
export const ACCEPT_COMMENT_ERROR = 'ACCEPT_COMMENT_ERROR'

export const REJECT_COMMENT = 'REJECT_COMMENT'
export const REJECT_COMMENT_SUCCESS = 'REJECT_COMMENT_SUCCESS'
export const REJECT_COMMENT_ERROR = 'REJECT_COMMENT_ERROR'

export const COMMENT_IS_META = 'COMMENT_IS_META'
export const COMMENT_IS_META_SUCCESS = 'COMMENT_IS_META_SUCCESS'
export const COMMENT_IS_META_ERROR = 'COMMENT_IS_META_ERROR'

export const REQUEST_PARTICIPANTS = 'REQUEST_PARTICIPANTS'
export const RECEIVE_PARTICIPANTS = 'RECEIVE_PARTICIPANTS'
export const PARTICIPANTS_FETCH_ERROR = 'PARTICIPANTS_FETCH_ERROR'

export const REQUEST_DEFAULT_PARTICIPANTS = 'REQUEST_DEFAULT_PARTICIPANTS'
export const RECEIVE_DEFAULT_PARTICIPANTS = 'RECEIVE_DEFAULT_PARTICIPANTS'
export const DEFAULT_PARTICIPANTS_FETCH_ERROR = 'DEFAULT_PARTICIPANTS_FETCH_ERROR'

export const REQUEST_FEATURED_PARTICIPANTS = 'REQUEST_FEATURED_PARTICIPANTS'
export const RECEIVE_FEATURED_PARTICIPANTS = 'RECEIVE_FEATURED_PARTICIPANTS'
export const FEATURED_PARTICIPANTS_FETCH_ERROR = 'FEATURED_PARTICIPANTS_FETCH_ERROR'

export const REQUEST_HIDDEN_PARTICIPANTS = 'REQUEST_HIDDEN_PARTICIPANTS'
export const RECEIVE_HIDDEN_PARTICIPANTS = 'RECEIVE_HIDDEN_PARTICIPANTS'
export const HIDDEN_PARTICIPANTS_FETCH_ERROR = 'HIDDEN_PARTICIPANTS_FETCH_ERROR'

/* participant actions */
export const FEATURE_PARTICIPANT = 'FEATURE_PARTICIPANT'
export const FEATURE_PARTICIPANT_SUCCESS = 'FEATURE_PARTICIPANT_SUCCESS'
export const FEATURE_PARTICIPANT_ERROR = 'FEATURE_PARTICIPANT_ERROR'

export const HIDE_PARTICIPANT = 'HIDE_PARTICIPANT'
export const HIDE_PARTICIPANT_SUCCESS = 'HIDE_PARTICIPANT_SUCCESS'
export const HIDE_PARTICIPANT_ERROR = 'HIDE_PARTICIPANT_ERROR'

/* submit seed comment */
export const SEED_COMMENT_LOCAL_UPDATE = 'SEED_COMMENT_LOCAL_UPDATE'
export const SUBMIT_SEED_COMMENT = 'SUBMIT_SEED_COMMENT'
export const SUBMIT_SEED_COMMENT_SUCCESS = 'SUBMIT_SEED_COMMENT_SUCCESS'
export const SUBMIT_SEED_COMMENT_ERROR = 'SUBMIT_SEED_COMMENT_ERROR'

export const REQUEST_SEED_COMMENTS = 'REQUEST_SEED_COMMENTS'
export const RECEIVE_SEED_COMMENTS = 'RECEIVE_SEED_COMMENTS'
export const SEED_COMMENTS_FETCH_ERROR = 'SEED_COMMENTS_FETCH_ERROR'

/* conversation stats */
export const REQUEST_CONVERSATION_STATS = 'REQUEST_CONVERSATION_STATS'
export const RECEIVE_CONVERSATION_STATS = 'RECEIVE_CONVERSATION_STATS'
export const CONVERSATION_STATS_FETCH_ERROR = 'CONVERSATION_STATS_FETCH_ERROR'

export const DATA_EXPORT_STARTED = 'DATA_EXPORT_STARTED'
export const DATA_EXPORT_SUCCESS = 'DATA_EXPORT_SUCCESS'
export const DATA_EXPORT_ERROR = 'DATA_EXPORT_ERROR'

// Legacy auth types removed - Auth/OIDC handles authentication

export const SUBMIT_CONTRIB = 'SUBMIT_CONTRIB'
export const SUBMIT_CONTRIB_SUCCESS = 'SUBMIT_CONTRIB_SUCCESS'
export const SUBMIT_CONTRIB_ERROR = 'SUBMIT_CONTRIB_ERROR'

/* MATH */

export const REQUEST_MATH = 'REQUEST_MATH'
export const RECEIVE_MATH = 'RECEIVE_MATH'
export const MATH_FETCH_ERROR = 'MATH_FETCH_ERROR'

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

/* zid metadata */

const requestZidMetadata = (conversation_id) => {
  return {
    type: REQUEST_ZID_METADATA,
    data: {
      conversation_id: conversation_id
    }
  }
}

const receiveZidMetadata = (data) => {
  return {
    type: RECEIVE_ZID_METADATA,
    data: data
  }
}

const zidMetadataFetchError = (err) => {
  return {
    type: ZID_METADATA_FETCH_ERROR,
    data: err
  }
}

export const resetMetadataStore = () => {
  return {
    type: ZID_METADATA_RESET
  }
}

const fetchZidMetadata = (conversation_id) => {
  return PolisNet.polisGet('/api/v3/conversations', {
    conversation_id: conversation_id
  })
}

export const populateZidMetadataStore = (conversation_id) => {
  return (dispatch, getState) => {
    const state = getState()
    const hasConversationId =
      state.zid_metadata &&
      state.zid_metadata.zid_metadata &&
      state.zid_metadata.zid_metadata.conversation_id

    const isLoading = state.zid_metadata.loading
    // NOTE: if there are multiple calls outstanding this may be wrong.
    const isLoadingThisConversation =
      state.zid_metadata.conversation_id === conversation_id && isLoading

    if (isLoadingThisConversation) {
      return
    }

    // don"t fetch again if we already have data loaded for that conversation.
    if (hasConversationId && state.zid_metadata.zid_metadata.conversation_id === conversation_id) {
      return
    }

    dispatch(requestZidMetadata(conversation_id))
    return fetchZidMetadata(conversation_id).then(
      (res) => dispatch(receiveZidMetadata(res)),
      (err) => dispatch(zidMetadataFetchError(err))
    )
  }
}

/* zid metadata update */

const updateZidMetadataStarted = () => {
  return {
    type: UPDATE_ZID_METADATA_STARTED
  }
}

const updateZidMetadataSuccess = (data) => {
  return {
    type: UPDATE_ZID_METADATA_SUCCESS,
    data: data
  }
}

const updateZidMetadataError = (err) => {
  return {
    type: UPDATE_ZID_METADATA_ERROR,
    data: err
  }
}

const updateZidMetadata = (zm, field, value) => {
  const data = {}
  data[field] = value
  const bodyData = Object.assign({}, zm, data)

  return PolisNet.polisPut('/api/v3/conversations', bodyData)
}

export const handleZidMetadataUpdate = (zm, field, value) => {
  return (dispatch) => {
    dispatch(updateZidMetadataStarted())
    return updateZidMetadata(zm, field, value)
      .then((res) => dispatch(updateZidMetadataSuccess(res)))
      .catch((err) => dispatch(updateZidMetadataError(err)))
  }
}

export const optimisticZidMetadataUpdateOnTyping = (zm, field, value) => {
  const nextZm = Object.assign({}, zm, { [field]: value })
  return {
    type: OPTIMISTIC_ZID_METADATA_UPDATE,
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

// FIXME
// eslint-disable-next-line no-unused-vars
const makeStandardStart = (type) => {
  return {
    type: type
  }
}

// FIXME
// eslint-disable-next-line no-unused-vars
const makeStandardError = (type, err) => {
  return {
    type: type,
    data: err
  }
}

// FIXME
// eslint-disable-next-line no-unused-vars
const makeStandardSuccess = (type, data) => {
  return {
    type: type,
    data: data
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

/* request all comments */

const requestComments = () => {
  return {
    type: REQUEST_COMMENTS
  }
}

const receiveComments = (data) => {
  return {
    type: RECEIVE_COMMENTS,
    data: data
  }
}

const commentsFetchError = (err) => {
  return {
    type: COMMENTS_FETCH_ERROR,
    data: err
  }
}

const fetchAllComments = (conversation_id) => {
  return PolisNet.polisGet('/api/v3/comments', {
    moderation: true,
    include_voting_patterns: false,
    conversation_id: conversation_id
  })
}

export const populateCommentsStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestComments())
    return fetchAllComments(conversation_id).then(
      (res) => dispatch(receiveComments(res)),
      (err) => dispatch(commentsFetchError(err))
    )
  }
}

/* request math */

const requestMath = () => {
  return {
    type: REQUEST_MATH
  }
}

const receiveMath = (data) => {
  return {
    type: RECEIVE_MATH,
    data: data
  }
}

const mathFetchError = (err) => {
  return {
    type: MATH_FETCH_ERROR,
    data: err
  }
}

const fetchMath = (conversation_id, math_tick) => {
  return PolisNet.polisGet('/api/v3/math/pca2', {
    math_tick: math_tick,
    conversation_id: conversation_id
  })
}

export const populateMathStore = (conversation_id) => {
  return (dispatch, getState) => {
    dispatch(requestMath())
    const math_tick = getState().math.math_tick
    return fetchMath(conversation_id, math_tick).then(
      (res) => dispatch(receiveMath(res)),
      (err) => dispatch(mathFetchError(err))
    )
  }
}

/* unmoderated comments */

const requestUnmoderatedComments = () => {
  return {
    type: REQUEST_UNMODERATED_COMMENTS
  }
}

const receiveUnmoderatedComments = (data) => {
  return {
    type: RECEIVE_UNMODERATED_COMMENTS,
    data: data
  }
}

const unmoderatedCommentsFetchError = (err) => {
  return {
    type: UNMODERATED_COMMENTS_FETCH_ERROR,
    data: err
  }
}

const fetchUnmoderatedComments = (conversation_id) => {
  const url = `/api/v3/comments?moderation=true&include_voting_patterns=false&mod=0&conversation_id=${conversation_id}`

  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch(url, {
      method: 'GET',
      headers: {
        ...(token && { Authorization: `Bearer ${token}` })
      }
    }).then((r) => r.json())
  )
}

export const populateUnmoderatedCommentsStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestUnmoderatedComments())
    return fetchUnmoderatedComments(conversation_id).then(
      (res) => dispatch(receiveUnmoderatedComments(res)),
      (err) => dispatch(unmoderatedCommentsFetchError(err))
    )
  }
}

/* accepted comments */

const requestAcceptedComments = () => {
  return {
    type: REQUEST_ACCEPTED_COMMENTS
  }
}

const receiveAcceptedComments = (data) => {
  return {
    type: RECEIVE_ACCEPTED_COMMENTS,
    data: data
  }
}

const acceptedCommentsFetchError = (err) => {
  return {
    type: ACCEPTED_COMMENTS_FETCH_ERROR,
    data: err
  }
}

const fetchAcceptedComments = (conversation_id) => {
  const url = `/api/v3/comments?moderation=true&include_voting_patterns=false&mod=1&conversation_id=${conversation_id}`

  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch(url, {
      method: 'GET',
      headers: {
        ...(token && { Authorization: `Bearer ${token}` })
      }
    }).then((r) => r.json())
  )
}

export const populateAcceptedCommentsStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestAcceptedComments())
    return fetchAcceptedComments(conversation_id).then(
      (res) => dispatch(receiveAcceptedComments(res)),
      (err) => dispatch(acceptedCommentsFetchError(err))
    )
  }
}

/* rejected comments */

const requestRejectedComments = () => {
  return {
    type: REQUEST_REJECTED_COMMENTS
  }
}

const receiveRejectedComments = (data) => {
  return {
    type: RECEIVE_REJECTED_COMMENTS,
    data: data
  }
}

const rejectedCommentsFetchError = (err) => {
  return {
    type: REJECTED_COMMENTS_FETCH_ERROR,
    data: err
  }
}

const fetchRejectedComments = (conversation_id) => {
  const url = `/api/v3/comments?moderation=true&include_voting_patterns=false&mod=-1&conversation_id=${conversation_id}`

  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch(url, {
      method: 'GET',
      headers: {
        ...(token && { Authorization: `Bearer ${token}` })
      }
    }).then((r) => r.json())
  )
}

export const populateRejectedCommentsStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestRejectedComments())
    return fetchRejectedComments(conversation_id).then(
      (res) => dispatch(receiveRejectedComments(res)),
      (err) => dispatch(rejectedCommentsFetchError(err))
    )
  }
}

/* populate ALL stores todo/accept/reject/seed */

export const populateAllCommentStores = (conversation_id) => {
  return (dispatch) => {
    return Promise.all([
      dispatch(populateUnmoderatedCommentsStore(conversation_id)),
      dispatch(populateAcceptedCommentsStore(conversation_id)),
      dispatch(populateRejectedCommentsStore(conversation_id))
    ])
  }
}

// export const populateAllCommentStores = (conversation) => {
// }

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

/* request participants */

const requestParticipants = () => {
  return {
    type: REQUEST_PARTICIPANTS
  }
}

const receiveParticipants = (data) => {
  return {
    type: RECEIVE_PARTICIPANTS,
    data: data
  }
}

const participantsFetchError = (err) => {
  return {
    type: PARTICIPANTS_FETCH_ERROR,
    data: err
  }
}

const fetchParticipants = (conversation_id) => {
  const url = `/api/v3/ptptois?conversation_id=${conversation_id}`

  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch(url, {
      method: 'GET',
      headers: {
        ...(token && { Authorization: `Bearer ${token}` })
      }
    }).then((r) => r.json())
  )
}

export const populateParticipantsStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestParticipants())
    return fetchParticipants(conversation_id).then(
      (res) => dispatch(receiveParticipants(res)),
      (err) => dispatch(participantsFetchError(err))
    )
  }
}

/* request default participants for ptpt moderation view */

const requestDefaultParticipants = () => {
  return {
    type: REQUEST_DEFAULT_PARTICIPANTS
  }
}

const receiveDefaultParticipants = (data) => {
  return {
    type: RECEIVE_DEFAULT_PARTICIPANTS,
    data: data
  }
}

const defaultParticipantFetchError = (err) => {
  return {
    type: DEFAULT_PARTICIPANTS_FETCH_ERROR,
    data: err
  }
}

const fetchDefaultParticipants = (conversation_id) => {
  const url = `/api/v3/ptptois?mod=0&conversation_id=${conversation_id}`

  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch(url, {
      method: 'GET',
      headers: {
        ...(token && { Authorization: `Bearer ${token}` })
      }
    }).then((r) => r.json())
  )
}

export const populateDefaultParticipantStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestDefaultParticipants())
    return fetchDefaultParticipants(conversation_id).then(
      (res) => dispatch(receiveDefaultParticipants(res)),
      (err) => dispatch(defaultParticipantFetchError(err))
    )
  }
}

/* request featured participants for ptpt moderation view */

const requestFeaturedParticipants = () => {
  return {
    type: REQUEST_FEATURED_PARTICIPANTS
  }
}

const receiveFeaturedParticipants = (data) => {
  return {
    type: RECEIVE_FEATURED_PARTICIPANTS,
    data: data
  }
}

const featuredParticipantFetchError = (err) => {
  return {
    type: FEATURED_PARTICIPANTS_FETCH_ERROR,
    data: err
  }
}

const fetchFeaturedParticipants = (conversation_id) => {
  const url = `/api/v3/ptptois?mod=1&conversation_id=${conversation_id}`

  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch(url, {
      method: 'GET',
      headers: {
        ...(token && { Authorization: `Bearer ${token}` })
      }
    }).then((r) => r.json())
  )
}

export const populateFeaturedParticipantStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestFeaturedParticipants())
    return fetchFeaturedParticipants(conversation_id).then(
      (res) => dispatch(receiveFeaturedParticipants(res)),
      (err) => dispatch(featuredParticipantFetchError(err))
    )
  }
}

/* request hidden participants for ptpt moderation view */

const requestHiddenParticipants = () => {
  return {
    type: REQUEST_HIDDEN_PARTICIPANTS
  }
}

const receiveHiddenParticipants = (data) => {
  return {
    type: RECEIVE_HIDDEN_PARTICIPANTS,
    data: data
  }
}

const hiddenParticipantFetchError = (err) => {
  return {
    type: HIDDEN_PARTICIPANTS_FETCH_ERROR,
    data: err
  }
}

const fetchHiddenParticipants = (conversation_id) => {
  const url = `/api/v3/ptptois?mod=-1&conversation_id=${conversation_id}`

  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch(url, {
      method: 'GET',
      headers: {
        ...(token && { Authorization: `Bearer ${token}` })
      }
    }).then((r) => r.json())
  )
}

export const populateHiddenParticipantStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestHiddenParticipants())
    return fetchHiddenParticipants(conversation_id).then(
      (res) => dispatch(receiveHiddenParticipants(res)),
      (err) => dispatch(hiddenParticipantFetchError(err))
    )
  }
}

/* populate ALL stores todo/accept/reject/seed */

export const populateAllParticipantStores = (conversation_id) => {
  return (dispatch) => {
    return Promise.all([
      dispatch(populateDefaultParticipantStore(conversation_id)),
      dispatch(populateFeaturedParticipantStore(conversation_id)),
      dispatch(populateHiddenParticipantStore(conversation_id))
    ])
  }
}

/* moderator clicked feature ptpt */

const optimisticFeatureParticipant = (participant) => {
  return {
    type: FEATURE_PARTICIPANT,
    participant: participant
  }
}

const featureParticipantSuccess = (data) => {
  return {
    type: FEATURE_PARTICIPANT_SUCCESS,
    data: data
  }
}

const featureParticipantError = (err) => {
  return {
    type: FEATURE_PARTICIPANT_ERROR,
    data: err
  }
}

const putFeatureParticipant = (participant) => {
  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch('/api/v3/ptptois', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` })
      },
      body: JSON.stringify(Object.assign(participant, { mod: 1 }))
    }).then((r) => r.json())
  )
}

export const changeParticipantStatusToFeatured = (participant) => {
  return (dispatch) => {
    dispatch(optimisticFeatureParticipant(participant))
    return putFeatureParticipant(participant).then(
      (res) => dispatch(featureParticipantSuccess(res)),
      (err) => dispatch(featureParticipantError(err))
    )
  }
}
/* moderator clicked hide ptpt */

const optimisticHideParticipant = (participant) => {
  return {
    type: FEATURE_PARTICIPANT,
    participant: participant
  }
}

const hideParticipantSuccess = (data) => {
  return {
    type: FEATURE_PARTICIPANT_SUCCESS,
    data: data
  }
}

const hideParticipantError = (err) => {
  return {
    type: FEATURE_PARTICIPANT_ERROR,
    data: err
  }
}

const putHideParticipant = (participant) => {
  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch('/api/v3/ptptois', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` })
      },
      body: JSON.stringify(Object.assign(participant, { mod: -1 }))
    }).then((r) => r.json())
  )
}

export const changeParticipantStatusToHidden = (participant) => {
  return (dispatch) => {
    dispatch(optimisticHideParticipant(participant))
    return putHideParticipant(participant).then(
      (res) => dispatch(hideParticipantSuccess(res)),
      (err) => dispatch(hideParticipantError(err))
    )
  }
}

/* moderator clicked unmoderate ptpt */
const optimisticUnmoderateParticipant = (participant) => {
  return {
    type: FEATURE_PARTICIPANT,
    participant: participant
  }
}

// FIXME
// eslint-disable-next-line no-unused-vars
const unmoderateParticipantSuccess = (data) => {
  return {
    type: FEATURE_PARTICIPANT_SUCCESS,
    data: data
  }
}

// FIXME
// eslint-disable-next-line no-unused-vars
const unmoderateParticipantError = (err) => {
  return {
    type: FEATURE_PARTICIPANT_ERROR,
    data: err
  }
}

const putUnmoderateParticipant = (participant) => {
  return PolisNet.getAccessTokenSilentlySPA().then((token) =>
    fetch('/api/v3/ptptois', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` })
      },
      body: JSON.stringify(Object.assign(participant, { mod: 0 }))
    }).then((r) => r.json())
  )
}

export const changeParticipantStatusToUnmoderated = (participant) => {
  return (dispatch) => {
    dispatch(optimisticUnmoderateParticipant(participant))
    return putUnmoderateParticipant(participant).then(
      (res) => dispatch(hideParticipantSuccess(res)),
      (err) => dispatch(hideParticipantError(err))
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

/* data export */

const dataExportStarted = () => {
  return {
    type: DATA_EXPORT_STARTED
  }
}

const dataExportSuccess = () => {
  return {
    type: DATA_EXPORT_SUCCESS
  }
}

const dataExportError = () => {
  return {
    type: DATA_EXPORT_ERROR
  }
}

const dataExportGet = (conversation_id, format, unixTimestamp, untilEnabled) => {
  let url = `/api/v3/dataExport?conversation_id=${conversation_id}&format=${format}`
  if (untilEnabled) {
    url += `&unixTimestamp=${unixTimestamp}`
  }
  return PolisNet.polisGet(url)
}

export const startDataExport = (conversation_id, format, unixTimestamp, untilEnabled) => {
  return (dispatch) => {
    dispatch(dataExportStarted())
    return dataExportGet(conversation_id, format, unixTimestamp, untilEnabled).then(
      (res) => dispatch(dataExportSuccess(res)),
      (err) => dispatch(dataExportError(err))
    )
  }
}
