import * as types from "../actions";

const seed_comments = (state = {
  pending: false,
}, action) => {
  switch (action.type) {
  case types.SUBMIT_SEED_COMMENT:
    console.log('in the seed store :D and see', action)
    return Object.assign({}, state, {
      pending: true,
      error: false,
    });
  case types.SUBMIT_SEED_COMMENT_SUCCESS:
    return Object.assign({}, state, {
      pending: false,
      error: false,
    });
  case types.SUBMIT_SEED_COMMENT_ERROR:
    return Object.assign({}, state, {
      pending: false,
      error: action.data.responseText,
    });


  case types.SUBMIT_SEED_COMMENT_TWEET:
    return Object.assign({}, state, {
      pending: true,
      error: false,
    });

  case types.SUBMIT_SEED_COMMENT_TWEET_SUCCESS:
    return Object.assign({}, state, {
      pending: false,
      error: false,
    });

  case types.SUBMIT_SEED_COMMENT_TWEET_ERROR: {
    return Object.assign({}, state, {
      pending: false,
      error: action.data.responseText,
    });
  }
  default:
    return state;
  }
};

export default seed_comments;
