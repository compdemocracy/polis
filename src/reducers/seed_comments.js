import * as types from "../actions";

const seed_comments = (state = {
  loading: false,
}, action) => {
  switch (action.type) {
  case types.SUBMIT_SEED_COMMENTS:
    console.log('in the seed store :D and see', action)
    return Object.assign({}, state, {
      loading: true
    });
  case types.SUBMIT_SEED_COMMENTS_SUCCESS:
    return Object.assign({}, state, {
      loading: false,
    });
  default:
    return state;
  }
};

export default seed_comments;
