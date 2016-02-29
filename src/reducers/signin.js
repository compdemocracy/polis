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
      facebookError: action.errorCode
    });
  case types.SIGNIN_INITIATED:
    return Object.assign({}, state, {
      loading: false,
      pending: true,
      facebookLoading: false,
      error: false,
    });
  case types.SIGNIN_ERROR:
    return Object.assign({}, state, {
      loading: false,
      pending: false,
      facebookLoading: false,
      error: action.data,
    });
  case types.CREATEUSER_INITIATED:
    return Object.assign({}, state, {
      loading: false,
      pending: true,
      facebookLoading: false,
      error: false,
    });
  case types.CREATEUSER_ERROR:
    return Object.assign({}, state, {
      loading: false,
      pending: false,
      facebookLoading: false,
      error: action.data,
    });







  default:
    return state;
  }
};

export default signin;







