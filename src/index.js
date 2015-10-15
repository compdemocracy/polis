import React from 'react';
import ReactDOM from 'react-dom';
import { Router, Route, Link } from 'react-router';
import { Provider, connect } from 'react-redux';
import { DevTools, DebugPanel, LogMonitor } from 'redux-devtools/lib/react';
import App from "./containers/app";
import configureStore from "./store";

const store = configureStore();

class Root extends React.Component {
  render() {
    return (
      <div>
        <Provider store={store}>
          <Router>
            <Route path="/" component={App}/>
          </Router>
        </Provider>
        <DebugPanel top right bottom>
          <DevTools store={store} monitor={LogMonitor} />
        </DebugPanel>
      </div>
    )
  }
}

ReactDOM.render(<Root/>, document.getElementById('root'));
