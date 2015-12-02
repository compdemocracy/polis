import * as types from "../actions";

const hidden_participants = (state = {
  loading: false,
  hidden_participants: null
}, action) => {
  switch (action.type) {
  case types.REQUEST_HIDDEN_PARTICIPANTS:
    return Object.assign({}, state, {
      loading: true
    });
  case types.RECEIVE_HIDDEN_PARTICIPANTS:
    return Object.assign({}, state, {
      loading: false,
      hidden_participants: action.data
    });
  default:
    return state;
  }
};

export default hidden_participants;
