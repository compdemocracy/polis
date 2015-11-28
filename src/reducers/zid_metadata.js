import * as types from "../actions";

const zid = (state = {
  loading: false,
  zid_metadata: {}
}, action) => {
  switch (action.type) {
  case types.REQUEST_ZID_METADATA:
    return Object.assign({}, state, {
      loading: true
    });
  case types.RECEIVE_ZID_METADATA:
    return Object.assign({}, state, {
      loading: false,
      zid_metadata: action.data
    });
  default:
    return state;
  }
};

export default zid;
