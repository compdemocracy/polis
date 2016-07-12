import * as types from "../actions";

const seed_comments_tweet = (state = {
  seedText: "",
  loading: false,
  error: false,
  success: false,
}, action) => {
  switch (action.type) {
  case types.SEED_COMMENT_TWEET_LOCAL_UPDATE:
    return Object.assign({}, state, {
      loading: false,
      error: false,
      seedTweetText: action.text,
      success: false
    });
  case types.SUBMIT_SEED_COMMENT_TWEET:
    return Object.assign({}, state, {
      loading: true,
      error: false,
    });
  case types.SUBMIT_SEED_COMMENT_TWEET_SUCCESS:
    return Object.assign({}, state, {
      seedTweetText: "",
      loading: false,
      error: false,
      success: true,
    });
  case types.SUBMIT_SEED_COMMENT_TWEET_ERROR: {
    return Object.assign({}, state, {
      loading: false,
      error: action.data.responseText,
    });
  }
  default:
    return state;
  }
};

export default seed_comments_tweet;
