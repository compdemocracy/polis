import * as types from "../actions";

const conversations = (state = {
  loading: false,
  message: "This is a list of conversations!"
}, action) => {
  switch (action.type) {
  case types.REQUEST_CONVERSATIONS:
    return Object.assign({}, state, {
      loading: true
    });
  case types.RECEIVE_CONVERSATIONS:
    return Object.assign({}, state, {
      loading: false,
      message: action.conversations
    });
  default:
    return state;
  }
};

export default conversations;
