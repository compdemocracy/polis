import $ from "jquery";

// types
export const REQUEST_CONVERSATIONS = "REQUEST_CONVERSATIONS";
export const RECEIVE_CONVERSATIONS = "RECEIVE_CONVERSATIONS";

export const requestConversations = () => {
  return {
    type: REQUEST_CONVERSATIONS
  };
};

export const receiveConversations = (data) => {
  return {
    type: RECEIVE_CONVERSATIONS,
    data: data
  };
};

export const fetchConversations = () => {
  // let the store know we're doing the call for loading state
  dispatch(requestConversations())
  return $.get('/api/v3/conversations?limit=100')
            .then((response) => {
              receiveConversations(response)
            })
}



// › eval `bin/herokuConfigExport`

//   in server/ on master
// › export PORT=5001

// to port code over, look at the requests and see what they do in the network pane

// didn't send up cookies? jquery does automatically... token2 is what we need https://www.dropbox.com/s/x36uokxv79qpngi/Screenshot%202015-11-08%2000.37.23.png?dl=0

// fetch('/api/v3/conversations?limit=100')
//   .then(function(response) {
//     return response.json()
//   }).then(function(json) {
//     console.log('parsed json', json)
//   }).catch(function(ex) {
//     console.log('parsing failed', ex)
//   })



export const fetchData = (message) => {
  return (dispatch) => {
    dispatch(requestData());
    setTimeout(() => {
      dispatch(receiveData({message}));
    }, 300)
  };
};
