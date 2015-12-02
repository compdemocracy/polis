import * as types from "../actions";

const accepted_comments = (state = {
  loading: false,
  accepted_comments: null
}, action) => {
  switch (action.type) {
  case types.REQUEST_ACCEPTED_COMMENTS:
    return Object.assign({}, state, {
      loading: true
    });
  case types.RECEIVE_ACCEPTED_COMMENTS:
    return Object.assign({}, state, {
      loading: false,
      accepted_comments: action.data
    });
  default:
    return state;
  }
};

export default accepted_comments;
