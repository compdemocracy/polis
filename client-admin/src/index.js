// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import $ from "jquery";

import React from "react";
import ReactDOM from "react-dom";
import { Provider } from "react-redux";

import { Router, Switch, Route, Link } from "react-router-dom";
import history from "./history";

import configureStore from "./store";
import { ThemeProvider } from "theme-ui";
import theme from "./theme";

// controller view
import Console from "./components/console";

import PasswordReset from "./components/password-reset";
import PasswordResetInit from "./components/password-reset-init";
import PasswordResetInitDone from "./components/password-reset-init-done";
import SignIn from "./components/signin";
import SignOut from "./components/signout";
import CreateUser from "./components/createuser";
import Contributor from "./components/contributors";

/* landers */

import Home from "./components/landers/home";

import TOS from "./components/tos";
import Privacy from "./components/privacy";
import Conversations from "./components/conversations";
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
import ReportCommentsIncluded from "./components/conversation-admin/report-comments-included";
import ReportCommentsExcluded from "./components/conversation-admin/report-comments-excluded";
import ReportsList from "./components/conversation-admin/reports-list";

const store = configureStore();

class Root extends React.Component {
  render() {
    return (
      <div>
        <ThemeProvider theme={theme}>
          <Provider store={store}>
            <Router history={history}>
              <Route path="/" component={Console}>
                <Route exact component={Conversations} />
                <Route path="other-conversations" component={Conversations} />
                <Route path="integrate" component={Integrate} />
                <Route path="overall-stats" component={OverallStats} />
                <Route path="account" component={Account} />
                <Route path="m/:conversation_id" component={ConversationAdminContainer}>
                  <Route exact component={ConversationConfig} />
                  <Route path="live" component={Live} />
                  <Route path="share" component={ShareAndEmbed} />
                  <Route path="summary" component={Summary} />
                  <Route path="reports" component={Reports}>
                    <Route exact component={ReportsList} />
                    <Route path=":report_id" component={Container}>
                      <Route exact component={ReportConfig} />
                      <Route path="comments" component={ReportComments}>
                        <Route exact component={ReportCommentsIncluded} />
                        <Route path="included" component={ReportCommentsIncluded} />
                        <Route path="excluded" component={ReportCommentsExcluded} />
                      </Route>
                    </Route>
                  </Route>
                  <Route path="reports" component={Reports} />
                  <Route path="comments" component={ModerateComments}>
                    <Route exact component={ModerateCommentsTodo} />
                    <Route path="accepted" component={ModerateCommentsAccepted} />
                    <Route path="rejected" component={ModerateCommentsRejected} />
                    <Route path="seed" component={ModerateCommentsSeed} />
                    <Route path="seed_tweet" component={ModerateCommentsSeedTweet} />
                  </Route>
                  <Route path="participants" component={ParticipantModeration}>
                    <Route exact component={ParticipantModerationDefault} />
                    <Route path="featured" component={ParticipantModerationFeatured} />
                    <Route path="hidden" component={ParticipantModerationHidden} />
                  </Route>
                  <Route path="stats" component={ConversationStats} />
                  <Route path="export" component={DataExport} />
                </Route>
              </Route>
              <Route path="home" component={Home} />

              <Route path="signin" component={SignIn} />
              <Route path="signin/*" component={SignIn} />
              <Route path="signin/**/*" component={SignIn} />
              <Route path="signout" component={SignOut} />
              <Route path="signout/*" component={SignOut} />
              <Route path="signout/**/*" component={SignOut} />
              <Route path="createuser" component={CreateUser} />
              <Route path="createuser/*" component={CreateUser} />
              <Route path="createuser/**/*" component={CreateUser} />
              <Route path="pwreset/*" component={PasswordReset} />
              <Route path="pwresetinit" component={PasswordResetInit} />
              <Route path="pwresetinit/done" component={PasswordResetInitDone} />
              <Route path="contrib" component={Contributor} />
              <Route path="tos" component={TOS} />
              <Route path="privacy" component={Privacy} />
            </Router>
          </Provider>
        </ThemeProvider>
      </div>
    );
  }
}

window.$ = $;

ReactDOM.render(<Root />, document.getElementById("root"));
