import * as types from "../actions";

const signin = (state = {
  loading: false,
  facebookLoading: false,
  error: false,
  facebookError: false
}, action) => {
  switch (action.type) {
  case types.FACEBOOK_SIGNIN_INITIATED:
    return Object.assign({}, state, {
      loading: false,
      facebookLoading: true,
      error: false,
      facebookError: false
    });
  case types.FACEBOOK_SIGNIN_SUCCESSFUL:
    return Object.assign({}, state, {
      loading: false,
      facebookLoading: false,
      error: false,
      facebookError: false
    });
  case types.FACEBOOK_SIGNIN_FAILED:
    return Object.assign({}, state, {
      loading: false,
      facebookLoading: false,
      error: false,
      facebookError: true
    });
  default:
    return state;
  }
};

export default signin;







