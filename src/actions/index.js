export const REQUEST_DATA = "REQUEST_DATA";
export const RECEIVE_DATA = "RECEIVE_DATA";

export const requestData = () => {
  return {
    type: REQUEST_DATA
  };
};

export const receiveData = (data) => {
  return {
    type: RECEIVE_DATA,
    data: data
  };
};

export const fetchData = () => {
  return (dispatch) => {
    dispatch(requestFourDollar());
    setTimeout(() => {
      dispatch(receiveFourDollar({message: "Hello"}));
    }, 300)
  };
};
