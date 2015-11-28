import * as types from "../actions";

const user = (state = {
  loading: false,
  user: null
}, action) => {
  switch (action.type) {
  case types.REQUEST_USER:
    return Object.assign({}, state, {
      loading: true
    });
  case types.RECEIVE_USER:
    return Object.assign({}, state, {
      loading: false,
      user: action.data
    });
  default:
    return state;
  }
};

export default user;
