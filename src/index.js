// React Core
import React from 'react';
import ReactDOM from 'react-dom';
// React Router
import { Router, Route, Link, IndexRoute, browserHistory } from 'react-router';
// React Redux
// import { Provider, connect } from 'react-redux';
// Redux Devtools

// import configureStore from "./store";

// controller view
import App from "./components/app";

// const store = configureStore();


class Root extends React.Component {
  render() {
    return (
      <div>
        <App/>
      </div>
    );
  }
}

// for material ui
import injectTapEventPlugin from "react-tap-event-plugin";

//Needed for onTouchTap
//Can go away when react 1.0 release
//Check this repo:
//https://github.com/zilverline/react-tap-event-plugin
injectTapEventPlugin();

ReactDOM.render(<Root/>, document.getElementById("root"));
