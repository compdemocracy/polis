import * as types from "../actions";

const data = (state = {
  loading: false,
  message: "It works!"
}, action) => {
  switch (action.type) {
  case types.REQUEST_DATA:
    return Object.assign({}, state, {
      loading: true
    });
  case types.RECEIVE_DATA:
    return Object.assign({}, state, {
      loading: false,
      message: action.data
    });
  default:
    return state;
  }
};

export default data;