import $ from "jquery";

/* ======= Types ======= */
export const REQUEST_USER = "REQUEST_USER";
export const RECEIVE_USER = "RECEIVE_USER";
export const USER_FETCH_ERROR = "USER_FETCH_ERROR";

export const REQUEST_CONVERSATIONS = "REQUEST_CONVERSATIONS";
export const RECEIVE_CONVERSATIONS = "RECEIVE_CONVERSATIONS";
export const CONVERSATIONS_FETCH_ERROR = "CONVERSATIONS_FETCH_ERROR";

/* zid for clarity */
export const REQUEST_ZID_METADATA = "REQUEST_ZID_METADATA";
export const RECEIVE_ZID_METADATA = "RECEIVE_ZID_METADATA";
export const ZID_METADATA_FETCH_ERROR = "ZID_METADATA_FETCH_ERROR"

/* config */

export const REQUEST_CONFIG = "REQUEST_CONFIG";
export const RECEIVE_CONFIG = "RECEIVE_CONFIG";
export const CONFIG_FETCH_ERROR = "CONFIG_FETCH_ERROR";

export const SAVE_CONFIG = "SAVE_CONFIG";
export const SAVE_CONFIG_SUCCESS = "SAVE_CONFIG_SUCCESS";
export const SAVE_CONFIG_ERROR = "SAVE_CONFIG_ERROR";

/* moderation */
export const REQUEST_UNMODERATED_COMMENTS = "REQUEST_UNMODERATED_COMMENTS";
export const RECEIVE_UNMODERATED_COMMENTS = "RECEIVE_UNMODERATED_COMMENTS";
export const UNMODERATED_COMMENTS_FETCH_ERROR = "UNMODERATED_COMMENTS_FETCH_ERROR";

export const REQUEST_ACCEPTED_COMMENTS = "REQUEST_ACCEPTED_COMMENTS";
export const RECEIVE_ACCEPTED_COMMENTS = "RECEIVE_ACCEPTED_COMMENTS";
export const ACCEPTED_COMMENTS_FETCH_ERROR = "ACCEPTED_COMMENTS_FETCH_ERROR";

export const REQUEST_REJECTED_COMMENTS = "REQUEST_REJECTED_COMMENTS";
export const RECEIVE_REJECTED_COMMENTS = "RECEIVE_REJECTED_COMMENTS";
export const REJECTED_COMMENTS_FETCH_ERROR = "REJECTED_COMMENTS_FETCH_ERROR";

export const ACCEPT_COMMENT = "ACCEPT_COMMENT";
export const ACCEPT_COMMENT_SUCCESS = "ACCEPT_COMMENT_SUCCESS";
export const ACCEPT_COMMENT_ERROR = "ACCEPT_COMMENT_ERROR";

export const REJECT_COMMENT = "REJECT_COMMENT";
export const REJECT_COMMENT_SUCCESS = "REJECT_COMMENT_SUCCESS";
export const REJECT_COMMENT_ERROR = "REJECT_COMMENT_ERROR";

export const REQUEST_DEFAULT_PARTICIPANTS = "REQUEST_DEFAULT_PARTICIPANTS";
export const RECEIVE_DEFAULT_PARTICIPANTS = "RECEIVE_DEFAULT_PARTICIPANTS";
export const DEFAULT_PARTICIPANTS_FETCH_ERROR = "DEFAULT_PARTICIPANTS_FETCH_ERROR";

export const REQUEST_FEATURED_PARTICIPANTS = "REQUEST_FEATURED_PARTICIPANTS";
export const RECEIVE_FEATURED_PARTICIPANTS = "RECEIVE_FEATURED_PARTICIPANTS";
export const FEATURED_PARTICIPANTS_FETCH_ERROR = "FEATURED_PARTICIPANTS_FETCH_ERROR";

export const REQUEST_HIDDEN_PARTICIPANTS = "REQUEST_HIDDEN_PARTICIPANTS";
export const RECEIVE_HIDDEN_PARTICIPANTS = "RECEIVE_HIDDEN_PARTICIPANTS";
export const HIDDEN_PARTICIPANTS_FETCH_ERROR = "HIDDEN_PARTICIPANTS_FETCH_ERROR";

/* participant actions no store, state not stored on client */
export const FEATURE_PARTICIPANT = "FEATURE_PARTICIPANT";
export const FEATURE_PARTICIPANT_SUCCESS = "FEATURE_PARTICIPANT_SUCCESS";
export const FEATURE_PARTICIPANT_ERROR = "FEATURE_PARTICIPANT_ERROR";

export const HIDE_PARTICIPANT = "HIDE_PARTICIPANT";
export const HIDE_PARTICIPANT_SUCCESS = "HIDE_PARTICIPANT_SUCCESS";
export const HIDE_PARTICIPANT_ERROR = "HIDE_PARTICIPANT_ERROR";

/* submit seed comment - no store, state not stored on client */
export const SUBMIT_SEED_COMMENT = "SUBMIT_SEED_COMMENT";
export const SUBMIT_SEED_COMMENT_SUCCESS = "SUBMIT_SEED_COMMENT_SUCCESS";
export const SUBMIT_SEED_COMMENT_ERROR = "SUBMIT_SEED_COMMENT_ERROR";

/* conversation stats */
export const REQUEST_CONVERSATION_STATS = "REQUEST_CONVERSATION_STATS";
export const RECEIVE_CONVERSATION_STATS = "RECEIVE_CONVERSATION_STATS";
export const CONVERSATION_STATS_FETCH_ERROR = "CONVERSATION_STATS_FETCH_ERROR";

/* ======= Actions ======= */

/*

  populate is the function the component calls
  fetch is the api call itself
  request tells everyone we're loading
  receive proxies the data to the store

*/

/* User */

const requestUser = () => {
  return {
    type: REQUEST_USER
  };
};

const receiveUser = (data) => {
  return {
    type: RECEIVE_USER,
    data: data
  };
};

const userFetchError = (err) => {
  return {
    type: USER_FETCH_ERROR,
    data: err
  }
}

const fetchUser = () => {
  return $.get('/api/v3/users');
}

export const populateUserStore = () => {
  return (dispatch) => {
    dispatch(requestUser())
    return fetchUser().then(
      res => dispatch(receiveUser(res)),
      err => dispatch(conversationsError(err))
    )
  }
}

/* Conversations */

const requestConversations = () => {
  return {
    type: REQUEST_CONVERSATIONS
  };
};

const receiveConversations = (data) => {
  return {
    type: RECEIVE_CONVERSATIONS,
    data: data
  };
};

const conversationsError = (err) => {
  return {
    type: CONVERSATIONS_FETCH_ERROR,
    data: err
  }
}

const fetchConversations = () => {
  return $.get('/api/v3/conversations');
}

export const populateConversationsStore = () => {
  return (dispatch) => {
    dispatch(requestConversations())
    return fetchConversations().then(
      res => dispatch(receiveConversations(res)),
      err => dispatch(conversationsError(err))
    )
  }
}

/* zid metadata */

// TODO zid is now conversation_id

const requestZidMetadata = () => {
  return {
    type: REQUEST_ZID_METADATA,
  };
};

const receiveZidMetadata = (data) => {
  return {
    type: RECEIVE_ZID_METADATA,
    data: data
  };
};

const zidMetadataFetchError = (err) => {
  return {
    type: ZID_METADATA_FETCH_ERROR,
    data: err
  }
}

const fetchZidMetadata = (conversation_id) => {
  return $.get('/api/v3/conversations?conversation_id='+conversation_id);
}

export const populateZidMetadataStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestZidMetadata())
    return fetchZidMetadata(conversation_id).then(
      res => dispatch(receiveZidMetadata(res)),
      err => dispatch(zidMetadataFetchError(err))
    )
  }
}

// TODO SUBMIT SEED COMMENT

// TODO SUBMIT CONFIG

/* unmoderated comments */

const requestUnmoderatedComments = () => {
  return {
    type: REQUEST_UNMODERATED_COMMENTS,
  };
};

const receiveUnmoderatedComments = (data) => {
  return {
    type: RECEIVE_UNMODERATED_COMMENTS,
    data: data
  };
};

const unmoderatedCommentsFetchError = (err) => {
  return {
    type: UNMODERATED_COMMENTS_FETCH_ERROR,
    data: err
  }
}

const fetchUnmoderatedComments = (conversation_id) => {
  return $.get('/api/v3/comments?moderation=true&mod=0&conversation_id=' + conversation_id);
}

export const populateUnmoderatedCommentsStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestUnmoderatedComments())
    return fetchUnmoderatedComments(conversation_id).then(
      res => dispatch(receiveUnmoderatedComments(res)),
      err => dispatch(unmoderatedCommentsFetchError(err))
    )
  }
}

/* accepted comments */

const requestAcceptedComments = () => {
  return {
    type: REQUEST_ACCEPTED_COMMENTS,
  };
};

const receiveAcceptedComments = (data) => {
  return {
    type: RECEIVE_ACCEPTED_COMMENTS,
    data: data
  };
};

const acceptedCommentsFetchError = (err) => {
  return {
    type: ACCEPTED_COMMENTS_FETCH_ERROR,
    data: err
  }
}

const fetchAcceptedComments = (conversation_id) => {
  return $.get('/api/v3/comments?moderation=true&mod=1&conversation_id=' + conversation_id);
}

export const populateAcceptedCommentsStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestAcceptedComments())
    return fetchAcceptedComments(conversation_id).then(
      res => dispatch(receiveAcceptedComments(res)),
      err => dispatch(acceptedCommentsFetchError(err))
    )
  }
}

/* rejected comments */

const requestRejectedComments = () => {
  return {
    type: REQUEST_REJECTED_COMMENTS,
  };
};

const receiveRejectedComments = (data) => {
  return {
    type: RECEIVE_REJECTED_COMMENTS,
    data: data
  };
};

const rejectedCommentsFetchError = (err) => {
  return {
    type: REJECTED_COMMENTS_FETCH_ERROR,
    data: err
  }
}

const fetchRejectedComments = (conversation_id) => {
  return $.get('/api/v3/comments?moderation=true&mod=-1&conversation_id=' + conversation_id);
}

export const populateRejectedCommentsStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestRejectedComments())
    return fetchRejectedComments(conversation_id).then(
      res => dispatch(receiveRejectedComments(res)),
      err => dispatch(rejectedCommentsFetchError(err))
    )
  }
}

/* moderator clicked accept comment */

const optimisticCommentAccepted = () => {
  /* don't know if this matters actually */
}

const acceptCommentSuccess = () => {

}

const acceptCommentError = () => {

}

const putCommentAccepted = (comment) => {
  console.log(comment)
  return $.ajax({
    method: "PUT",
    url: "/api/v3/comments",
    data: comment
  })
}

export const changeCommentStatusToAccepted = (comment) => {
  return (dispatch) => {
    dispatch(optimisticCommentAccepted())
    return putCommentAccepted(comment).then(
      res => dispatch(acceptCommentSuccess(res)),
      err => dispatch(acceptCommentError(err))
    )
  }
}

/* moderator clicked reject comment */

const optimisticCommentRejected = () => {

}

const rejectCommentSuccess = () => {

}

const rejectCommentError = () => {

}

const putCommentRejected = (comment) => {

  return $.ajax({
    method: "PUT",
    url: "/api/v3/comments",
    data: comment
  })
}

export const changeCommentStatusToRejected = (comment) => {
  return (dispatch) => {
    dispatch(optimisticCommentRejected())
    return putCommentRejected(conversation_id, comment).then(
      res => dispatch(rejectCommentSuccess(res)),
      err => dispatch(rejectCommentError(err))
    )
  }
}
/* request default participants for ptpt moderation view */

const requestDefaultParticipants = () => {
  return {
    type: REQUEST_DEFAULT_PARTICIPANTS,
  };
};

const receiveDefaultParticipants = (data) => {
  return {
    type: RECEIVE_DEFAULT_PARTICIPANTS,
    data: data
  };
};

const defaultParticipantFetchError = (err) => {
  return {
    type: DEFAULT_PARTICIPANTS_FETCH_ERROR,
    data: err
  }
}

const fetchDefaultParticipants = (conversation_id) => {
  return $.get('/api/v3/ptptois?mod=0&conversation_id=' + conversation_id);
}

export const populateDefaultParticipantStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestDefaultParticipants())
    return fetchDefaultParticipants(conversation_id).then(
      res => dispatch(receiveDefaultParticipants(res)),
      err => dispatch(defaultParticipantFetchError(err))
    )
  }
}

/* request featured participants for ptpt moderation view */

const requestFeaturedParticipants = () => {
  return {
    type: REQUEST_FEATURED_PARTICIPANTS,
  };
};

const receiveFeaturedParticipants = (data) => {
  return {
    type: RECEIVE_FEATURED_PARTICIPANTS,
    data: data
  };
};

const featuredParticipantFetchError = (err) => {
  return {
    type: FEATURED_PARTICIPANTS_FETCH_ERROR,
    data: err
  }
}

const fetchFeaturedParticipants = (conversation_id) => {
  return $.get('/api/v3/ptptois?mod=1&conversation_id=' + conversation_id);
}

export const populateFeaturedParticipantStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestFeaturedParticipants())
    return fetchFeaturedParticipants(conversation_id).then(
      res => dispatch(receiveFeaturedParticipants(res)),
      err => dispatch(featuredParticipantFetchError(err))
    )
  }
}

/* request hidden participants for ptpt moderation view */

const requestHiddenParticipants = () => {
  return {
    type: REQUEST_FEATURED_PARTICIPANTS,
  };
};

const receiveHiddenParticipants = (data) => {
  return {
    type: RECEIVE_FEATURED_PARTICIPANTS,
    data: data
  };
};

const hiddenParticipantFetchError = (err) => {
  return {
    type: FEATURED_PARTICIPANTS_FETCH_ERROR,
    data: err
  }
}

const fetchHiddenParticipants = (conversation_id) => {
  return $.get('/api/v3/ptptois?mod=-1&conversation_id=' + conversation_id);
}

export const populateHiddenParticipantStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestHiddenParticipants())
    return fetchHiddenParticipants(conversation_id).then(
      res => dispatch(receiveHiddenParticipants(res)),
      err => dispatch(hiddenParticipantFetchError(err))
    )
  }
}

/* moderator clicked feature ptpt */

// TODO FEATURE_PARTICIPANT

/* moderator clicked hide ptpt */

// TODO HIDE_PARTICIPANT

/* request conversation stats */

const requestConversationStats = () => {
  return {
    type: REQUEST_CONVERSATION_STATS,
  };
};

const receiveConversationStats = (data) => {
  return {
    type: RECEIVE_CONVERSATION_STATS,
    data: data
  };
};

const conversationStatsFetchError = (err) => {
  return {
    type: CONVERSATION_STATS_FETCH_ERROR,
    data: err
  }
}

const fetchConversationStats = (conversation_id) => {
  return $.get('/api/v3/conversationStats?conversation_id=' + conversation_id);
}

export const populateConversationStatsStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestConversationStats())
    return fetchConversationStats(conversation_id).then(
      res => dispatch(receiveConversationStats(res)),
      err => dispatch(conversationStatsFetchError(err))
    )
  }
}