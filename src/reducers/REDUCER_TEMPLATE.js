import * as types from "../actions";

const ReducerTitle = (state = {
  loading: false,
  qux: null,
  error: null
}, action) => {
  switch (action.type) {
  case types.REQUEST_FOO:
    return Object.assign({}, state, {
      loading: true,
      error: null
    });
  case types.RECEIVE_FOO:
    return Object.assign({}, state, {
      loading: false,
      error: null,
      qux: action.data
    });
  case types.FOO_FETCH_ERROR:
    return Object.assign({}, state, {
      loading: false,
      error: action.data
    });
  default:
    return state;
  }
};

export default ReducerTitle;
