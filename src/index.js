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

// controller view
import Console from "./components/console";

// top level navigation
import Conversations from "./components/conversations";
import CreateConversation from "./components/create-conversation";
import Integrate from "./components/integrate";
// this may become '/' defaultview - with instructions if no stats to show
import OverallStats from "./components/overall-stats";
import Account from "./components/account";

// /conversation-admin
import ConversationAdminContainer from "./components/conversation-admin/container";

import ConversationConfig from "./components/conversation-admin/conversation-config";
import ConversationStats from "./components/conversation-admin/conversation-stats";

import ModerateComments from "./components/conversation-admin/moderate-comments";
import ModerateCommentsTodo from "./components/conversation-admin/moderate-comments-todo";
import ModerateCommentsAccepted from "./components/conversation-admin/moderate-comments-accepted";
import ModerateCommentsRejected from "./components/conversation-admin/moderate-comments-rejected";
import ModerateCommentsSeed from "./components/conversation-admin/moderate-comments-seed";

import ParticipantModeration from "./components/conversation-admin/moderate-people";
import ParticipantModerationDefault from "./components/conversation-admin/moderate-people-default";
import ParticipantModerationFeatured from "./components/conversation-admin/moderate-people-featured";
import ParticipantModerationHidden from "./components/conversation-admin/moderate-people-hidden";


const store = configureStore();

class Root extends React.Component {
  render() {
    return (
      <div>
        <Provider store={store}>
          <Router>
            <Route path="/" component={Console}>
              <Route path="/new" component={CreateConversation}/>
              <Route path="/integrate" component={Integrate}/>
              <Route path="conversations" component={Conversations}/>
              <Route path="overall-stats" component={OverallStats}/>
              <Route path="account" component={Account}/>
              <Route path="m/:conversation" component={ConversationAdminContainer}>
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
            </Route>
          </Router>
        </Provider>
        <DebugPanel top right bottom>
          <DevTools store={store} visibleOnLoad={false} monitor={LogMonitor} />
        </DebugPanel>
      </div>
    )
  }
}

ReactDOM.render(<Root/>, document.getElementById('root'));
