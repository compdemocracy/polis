import { createStore, applyMiddleware, compose } from "redux";
import thunk from "redux-thunk";
import { devTools } from 'redux-devtools';
import createHistory from 'history/lib/createBrowserHistory';

import rootReducer from "../reducers";

const middleware = [thunk];

let finalCreateStore;

if (process.env.NODE_ENV === 'production') {
  finalCreateStore = applyMiddleware(...middleware)(createStore);
} else {
  finalCreateStore = compose(
    applyMiddleware(...middleware),
    require('redux-devtools').devTools(),
    require('redux-devtools').persistState(
      window.location.href.match(/[?&]debug_session=([^&]+)\b/)
    )
  )(createStore);
}

const configureStore = function (initialState) {
  return finalCreateStore(rootReducer, initialState);
};

export default configureStore;
