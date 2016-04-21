export const REQUEST_BAZ = "REQUEST_BAZ";
export const RECEIVE_BAZ = "RECEIVE_BAZ";
export const BAZ_FETCH_ERROR = "BAZ_FETCH_ERROR";

/* request foo */

const requestFoo = () => {
  return {
    type: REQUEST_BAZ
  }
};

const receiveFoo = (data) => {
  return {
    type: RECEIVE_BAZ,
    data: data
  }
};

const barFetchError = (err) => {
  return {
    type: BAZ_FETCH_ERROR,
    data: err
  }
}

const fetchFoo = (conversation_id) => {
  return $.get("/api/v3/QUX?conversation_id=" + conversation_id);
};

export const populateFooStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestFoo());
    return fetchFoo(conversation_id).then(
      (res) => dispatch(receiveFoo(res)),
      (err) => dispatch(barFetchError(err))
    );
  };
};
