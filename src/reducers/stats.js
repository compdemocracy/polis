import * as types from "../actions";

const conversation_stats = (state = {
  loading: false,
  conversation_stats: {},
}, action) => {
  switch (action.type) {
  case types.REQUEST_CONVERSATION_STATS:
    return Object.assign({}, state, {
      loading: true
    });
  case types.RECEIVE_CONVERSATION_STATS:
    return Object.assign({}, state, {
      loading: false,
      conversation_stats: action.data
    });
  default:
    return state;
  }
};

export default conversation_stats;
