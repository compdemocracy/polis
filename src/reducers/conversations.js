import * as types from "../actions";

const conversations = (state = {
  loading: false,
  error: false,
  conversations: null
}, action) => {
  switch (action.type) {
  case types.REQUEST_CONVERSATIONS:
    return Object.assign({}, state, {
      loading: true,
      error: false,
    });
  case types.RECEIVE_CONVERSATIONS:
    return Object.assign({}, state, {
      loading: false,
      error: false,
      conversations: action.data
    });
  case types.CONVERSATIONS_FETCH_ERROR:
    return Object.assign({}, state, {
      loading: false,
      error: action.data,
      conversations: null
    })
  default:
    return state;
  }
};

export default conversations;
