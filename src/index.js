// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import $ from 'jquery';

// React Core
import React from 'react';
import ReactDOM from 'react-dom';
// React Router
import { Router, Route, Link, IndexRoute, browserHistory } from 'react-router';
// React Redux
import { Provider, connect } from 'react-redux';
// Redux Devtools
import { DevTools, DebugPanel, LogMonitor } from 'redux-devtools/lib/react';

import configureStore from "./store";

// controller view
import Console from "./components/console";

// top level navigation
import PasswordReset from "./components/password-reset";
import PasswordResetInit from "./components/password-reset-init";
import PasswordResetInitDone from "./components/password-reset-init-done";
import SignIn from "./components/signin";
import SignOut from "./components/signout";
import CreateUser from "./components/createuser";
import Contributor from "./components/contributors";
/* landers */
import News from "./components/landers/news";
import News2 from "./components/landers/news2";
import Home from "./components/landers/homepage";
import Plus from "./components/landers/plus";
import Bot from "./components/landers/bot";
import BotInstall from "./components/landers/bot-install";
import Gov from "./components/landers/gov";
import Demo from "./components/landers/demo";
import Meta from "./components/landers/metalander";
import Company from "./components/landers/company";

import TOS from "./components/tos";
import Privacy from "./components/privacy";
import Conversations from "./components/conversations";
// import OtherConversations from "./components/OtherConversations";
import Integrate from "./components/integrate";
// this may become '/' defaultview - with instructions if no stats to show
import OverallStats from "./components/overall-stats";
import Account from "./components/account";

import Container from "./components/container";

// /conversation-admin
import ConversationAdminContainer from "./components/conversation-admin/container";

import ConversationConfig from "./components/conversation-admin/conversation-config";
import ConversationStats from "./components/conversation-admin/conversation-stats";

import ModerateComments from "./components/conversation-admin/moderate-comments";
import ModerateCommentsTodo from "./components/conversation-admin/moderate-comments-todo";
import ModerateCommentsAccepted from "./components/conversation-admin/moderate-comments-accepted";
import ModerateCommentsRejected from "./components/conversation-admin/moderate-comments-rejected";
import ModerateCommentsSeed from "./components/conversation-admin/moderate-comments-seed";
import ModerateCommentsSeedTweet from "./components/conversation-admin/moderate-comments-seed-tweet";

import ParticipantModeration from "./components/conversation-admin/moderate-people";
import ParticipantModerationDefault from "./components/conversation-admin/moderate-people-default";
import ParticipantModerationFeatured from "./components/conversation-admin/moderate-people-featured";
import ParticipantModerationHidden from "./components/conversation-admin/moderate-people-hidden";

import DataExport from "./components/conversation-admin/data-export";
import ShareAndEmbed from "./components/conversation-admin/share-and-embed";
import Live from "./components/conversation-admin/live";
import Summary from "./components/conversation-admin/summary";

import Reports from "./components/conversation-admin/reports";
import ReportConfig from "./components/conversation-admin/report-config";
import ReportComments from "./components/conversation-admin/report-comments";
import ReportsList from "./components/conversation-admin/reports-list";



const store = configureStore();

class Root extends React.Component {
  render() {
    return (
      <div>
        <Provider store={store}>
          <Router history={browserHistory}>
            <Route path="/" component={Console}>
              <IndexRoute component={Conversations}/>
              <Route path="other-conversations" component={Conversations}/>
              <Route path="integrate" component={Integrate}/>
              <Route path="overall-stats" component={OverallStats}/>
              <Route path="account" component={Account}/>
              <Route path="m/:conversation_id" component={ConversationAdminContainer}>
                <IndexRoute component={ConversationConfig}/>
                <Route path="live" component={Live}/>
                <Route path="share" component={ShareAndEmbed}/>
                <Route path="summary" component={Summary}/>
                <Route path="reports" component={Reports}>
                  <IndexRoute component={ReportsList}/>
                  <Route path=":report_id" component={Container}>
                    <IndexRoute component={ReportConfig}/>
                  <Route path="comments" component={ReportComments}>
                    <IndexRoute component={ModerateCommentsTodo}/>
                    <Route path="accepted" component={ModerateCommentsAccepted}/>
                    <Route path="rejected" component={ModerateCommentsRejected}/>
                    <Route path="seed" component={ModerateCommentsSeed}/>
                    <Route path="seed_tweet" component={ModerateCommentsSeedTweet}/>
                  </Route>
                  </Route>
                </Route>
                <Route path="reports" component={Reports}/>
                <Route path="comments" component={ModerateComments}>
                  <IndexRoute component={ModerateCommentsTodo}/>
                  <Route path="accepted" component={ModerateCommentsAccepted}/>
                  <Route path="rejected" component={ModerateCommentsRejected}/>
                  <Route path="seed" component={ModerateCommentsSeed}/>
                  <Route path="seed_tweet" component={ModerateCommentsSeedTweet}/>
                </Route>
                <Route path="participants" component={ParticipantModeration}>
                  <IndexRoute component={ParticipantModerationDefault}/>
                  <Route path="featured" component={ParticipantModerationFeatured}/>
                  <Route path="hidden" component={ParticipantModerationHidden}/>
                </Route>
                <Route path="stats" component={ConversationStats}/>
                <Route path="export" component={DataExport}/>
              </Route>
            </Route>
            <Route path="news" component={News2}/>
            <Route path="plus" component={Plus}/>
            <Route path="home" component={Meta}/>
            <Route path="company" component={Company}/>
            <Route path="bot" component={Bot}/>
            <Route path="bot/install" component={BotInstall}/>
            <Route path="gov" component={Gov}/>
            <Route path="demo" component={Demo}/>
            <Route path="signin" component={SignIn}/>
            <Route path="signin/*" component={SignIn}/>
            <Route path="signin/**/*" component={SignIn}/>
            <Route path="signout" component={SignOut}/>
            <Route path="signout/*" component={SignOut}/>
            <Route path="signout/**/*" component={SignOut}/>
            <Route path="createuser" component={CreateUser}/>
            <Route path="createuser/*" component={CreateUser}/>
            <Route path="createuser/**/*" component={CreateUser}/>
            <Route path="pwreset/*" component={PasswordReset}/>
            <Route path="pwresetinit" component={PasswordResetInit}/>
            <Route path="pwresetinit/done" component={PasswordResetInitDone}/>
            <Route path="contrib" component={Contributor}/>
            <Route path="tos" component={TOS}/>
            <Route path="privacy" component={Privacy}/>
          </Router>
        </Provider>
        <DebugPanel top right bottom>
          <DevTools store={store} visibleOnLoad={false} monitor={LogMonitor} />
        </DebugPanel>
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


window.$ = $;

ReactDOM.render(<Root/>, document.getElementById("root"));
