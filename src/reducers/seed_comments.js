import * as types from "../actions";

const seed_comments = (state = {
  seedText: "",
  loading: false,
  error: false,
  success: false
}, action) => {
  switch (action.type) {
  case types.SEED_COMMENT_LOCAL_UPDATE:
    return Object.assign({}, state, {
      loading: false,
      error: false,
      seedText: action.text,
      success: false
    });
  case types.SUBMIT_SEED_COMMENT:
    return Object.assign({}, state, {
      loading: true,
      error: false,
      success: false
    });
  case types.SUBMIT_SEED_COMMENT_SUCCESS:
    return Object.assign({}, state, {
      loading: false,
      seedText: "",
      error: false,
      success: true
    });
  case types.SUBMIT_SEED_COMMENT_ERROR:
    return Object.assign({}, state, {
      loading: false,
      error: true,
      success: false
    });

  default:
    return state;
  }
};

export default seed_comments;
