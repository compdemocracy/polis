// React Core
import React from 'react';
import ReactDOM from 'react-dom';
// React Router
import { Router, Route, Link } from 'react-router';
// React Redux
import { Provider, connect } from 'react-redux';
// Redux Devtools
import { DevTools, DebugPanel, LogMonitor } from 'redux-devtools/lib/react';

import configureStore from "./store";

// Top level component
import Console from "./components/console";

// Primary navigation
import ModerateComments from "./components/moderate-comments";
import ParticipantModeration from "./components/moderate-people";
import ConversationConfig from "./components/conversation-config";
import ConversationStats from "./components/conversation-stats";

// Secondary navigation
import ModerateCommentsTodo from "./components/moderate-comments-todo";
import ModerateCommentsAccepted from "./components/moderate-comments-accepted";
import ModerateCommentsRejected from "./components/moderate-comments-rejected";
import ModerateCommentsSeed from "./components/moderate-comments-seed";

import ParticipantModerationDefault from "./components/moderate-people-default";
import ParticipantModerationFeatured from "./components/moderate-people-featured";
import ParticipantModerationHidden from "./components/moderate-people-hidden";

import Inbox from "./components/inbox";

const store = configureStore();

class Root extends React.Component {
  render() {
    return (
      <div>
        <Provider store={store}>
          <Router>
            <Route path="/" component={Console}>
              <Route path="inbox" components={Inbox}/>
              <Route path="comments" component={ModerateComments}>
                <Route path="todo" component={ModerateCommentsTodo}/>
                <Route path="accepted" component={ModerateCommentsAccepted}/>
                <Route path="rejected" component={ModerateCommentsRejected}/>
                <Route path="seed" component={ModerateCommentsSeed}/>
              </Route>
              <Route path="participants" component={ParticipantModeration}>
                <Route path="default" component={ParticipantModerationDefault}/>
                <Route path="featured" component={ParticipantModerationFeatured}/>
                <Route path="hidden" component={ParticipantModerationHidden}/>
              </Route>
              <Route path="config" component={ConversationConfig}/>
              <Route path="stats" component={ConversationStats}/>
            </Route>
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
