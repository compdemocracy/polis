import * as types from "../actions";

const zid = (state = {
  loading: false,
  zid_metadata: {},
  error: null
}, action) => {
  console.log("state", state, "action", action)
  switch (action.type) {
  case types.REQUEST_ZID_METADATA:
    return Object.assign({}, state, {
      loading: true,
      error: null
    });
  case types.RECEIVE_ZID_METADATA:
    return Object.assign({}, state, {
      loading: false,
      zid_metadata: action.data,
      error: null
    });
  case types.UPDATE_ZID_METADATA_STARTED:
    return Object.assign({}, state, {
      loading: true,
      error: null
    });
  case types.UPDATE_ZID_METADATA_SUCCESS:
    return Object.assign({}, state, {
      loading: false,
      zid_metadata: action.data,
      error: null
    });
  case types.UPDATE_ZID_METADATA_ERROR:
    return Object.assign({}, state, {
      loading: false,
      error: action.err
    });
  default:
    return state;
  }
};

export default zid;
