import * as types from "../actions";
import _ from "lodash";

const accepted_comments = (state = {
  loading: false,
  comments: null,
  error: null
}, action) => {
  switch (action.type) {
  case types.REQUEST_COMMENTS:
    return Object.assign({}, state, {
      loading: true,
      error: null
    });
  case types.RECEIVE_COMMENTS:
    return Object.assign({}, state, {
      loading: false,
      error: null,
      comments: _.sortBy(action.data, "tid")
    });
  case types.COMMENTS_FETCH_ERROR:
    return Object.assign({}, state, {
      loading: false,
      error: action.data
    });
  default:
    return state;
  }
};

export default accepted_comments;
