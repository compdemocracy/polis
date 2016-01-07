import * as types from "../actions";

const signout = (state = {
  loading: false,
  signout: false,
  error: false
}, action) => {
  switch (action.type) {
  case types.SIGNOUT_INITIATED:
    return Object.assign({}, state, {
      loading: true,
      error: false
    });
  case types.SIGNOUT_SUCCESSFUL:
    return Object.assign({}, state, {
      loading: false,
      signout: true,
      error: false
    });
  case types.SIGNOUT_SUCCESSFUL:
    return Object.assign({}, state, {
      loading: false,
      signout: false,
      error: true
    });
  default:
    return state;
  }
};

export default signout;
