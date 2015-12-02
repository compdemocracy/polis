import * as types from "../actions";

const default_participants = (state = {
  loading: false,
  default_participants: null
}, action) => {
  switch (action.type) {
  case types.REQUEST_DEFAULT_PARTICIPANTS:
    return Object.assign({}, state, {
      loading: true
    });
  case types.RECEIVE_DEFAULT_PARTICIPANTS:
    return Object.assign({}, state, {
      loading: false,
      default_participants: action.data
    });
  default:
    return state;
  }
};

export default default_participants;
