import * as types from "../actions";

const unmoderated_comments = (state = {
  loading: false,
  unmoderated_comments: {},
}, action) => {
  switch (action.type) {
  case types.REQUEST_UNMODERATED_COMMENTS:
    return Object.assign({}, state, {
      loading: true
    });
  case types.RECEIVE_UNMODERATED_COMMENTS:
    return Object.assign({}, state, {
      loading: false,
      unmoderated_comments: action.data
    });
  default:
    return state;
  }
};

export default unmoderated_comments;
