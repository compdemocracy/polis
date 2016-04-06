import * as types from "../actions";

const Math = (state = {
  loading: false,
  math: null,
  lastVoteTimestamp: -1,
  error: null
}, action) => {
  switch (action.type) {
  case types.REQUEST_MATH:
    return Object.assign({}, state, {
      loading: true,
      error: null
    });
  case types.RECEIVE_MATH:
    return Object.assign({}, state, {
      loading: false,
      error: null,
      math: action.data,
      lastVoteTimestamp: action.data /* this will blow up just haven't checked obj innards yet */
    });
  case types.MATH_FETCH_ERROR:
    return Object.assign({}, state, {
      loading: false,
      error: action.data
    });
  default:
    return state;
  }
};

export default Math;
