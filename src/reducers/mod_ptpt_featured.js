import * as types from "../actions";

const featured_participants = (state = {
  loading: false,
  featured_participants: null
}, action) => {
  switch (action.type) {
  case types.REQUEST_FEATURED_PARTICIPANTS:
    return Object.assign({}, state, {
      loading: true
    });
  case types.RECEIVE_FEATURED_PARTICIPANTS:
    return Object.assign({}, state, {
      loading: false,
      featured_participants: action.data
    });
  default:
    return state;
  }
};

export default featured_participants;
