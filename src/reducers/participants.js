import * as types from "../actions";

const Participants = (state = {
  loading: false,
  participants: null,
  error: null
}, action) => {
  switch (action.type) {
  case types.REQUEST_PARTICIPANTS:
    return Object.assign({}, state, {
      loading: true,
      error: null
    });
  case types.RECEIVE_PARTICIPANTS:
    return Object.assign({}, state, {
      loading: false,
      error: null,
      participants: action.data
    });
  case types.PARTICIPANTS_FETCH_ERROR:
    return Object.assign({}, state, {
      loading: false,
      error: action.data
    });
  default:
    return state;
  }
};

export default Participants;
