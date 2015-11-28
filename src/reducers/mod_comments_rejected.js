import * as types from "../actions";

const rejected_comments = (state = {
  loading: false,
  rejected_comments: {},
}, action) => {
  switch (action.type) {
  case types.REQUEST_REJECTED_COMMENTS:
    return Object.assign({}, state, {
      loading: true
    });
  case types.RECEIVE_REJECTED_COMMENTS:
    return Object.assign({}, state, {
      loading: false,
      rejected_comments: action.data
    });
  default:
    return state;
  }
};

export default rejected_comments;
