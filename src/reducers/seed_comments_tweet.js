// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

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
