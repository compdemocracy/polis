// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import { populateUserStore } from "./actions";

import Radium from "radium";
import _ from "lodash";
import Flex from "./components/framework/flex";

import { Switch, Route, Link } from "react-router-dom";

import Conversations from "./components/conversations";

import PasswordReset from "./components/password-reset";
import PasswordResetInit from "./components/password-reset-init";
import PasswordResetInitDone from "./components/password-reset-init-done";
import SignIn from "./components/signin";
import SignOut from "./components/signout";
import CreateUser from "./components/createuser";

/* landers */

import Home from "./components/landers/home";

import TOS from "./components/tos";
import Privacy from "./components/privacy";
import Integrate from "./components/integrate";
// this may become '/' defaultview - with instructions if no stats to show
import Account from "./components/account";

@connect((state) => {
  return state.user;
})
@Radium
class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      sidebarOpen: false,
      // sidebarDocked: true,
    };
  }

  loadUserData() {
    this.props.dispatch(populateUserStore());
  }

  componentWillMount() {
    this.loadUserData();
    let mql = window.matchMedia(`(min-width: 800px)`);
    mql.addListener(this.mediaQueryChanged.bind(this));
    this.setState({ mql: mql, docked: mql.matches });
    this.checkForAuth(this.props);
  }

  componentWillReceiveProps(nextProps) {
    this.checkForAuth(nextProps);
  }

  checkForAuth(props) {
    if (!_.isUndefined(props.isLoggedIn)) {
      var shouldRedirect = props.error
        ? props.status === 401 || props.status === 403
        : !props.isLoggedIn;

      if (shouldRedirect) {
        window.location = "/signin" + this.props.location.pathname;
      }
    }
  }

  componentDidMount() {
    this.mediaQueryChanged();
  }

  initIntercom() {
    if (window.useIntercom && !this.intercomInitialized) {
      const user = this.props.user;
      if (user) {
        if (!window.Intercom && user && user.uid) {
          window.initIntercom();
        }
        if (user.email) {
          /*eslint-disable */
          /* jshint ignore:start */
          Intercom("boot", {
            app_id: "nb5hla8s",
            created_at: (user.created / 1000) >> 0,
            user_id: user.uid,
          });
          /* jshint ignore:end */
          /*eslint-enable */
        }
        this.intercomInitialized = true;
      }
    }
  }

  updateIntercomSettings() {
    this.initIntercom();
    if (this.intercomInitialized) {
      const user = this.props.user;
      window.intercomOptions = {
        app_id: "nb5hla8s",
        widget: {
          activator: "#IntercomDefaultWidget",
        },
      };
      if (user && user.uid) {
        intercomOptions.user_id = user.uid + "";
      }
      if (user && user.email) {
        intercomOptions.email = user.email;
      }
      if (user && user.created) {
        intercomOptions.created_at = (user.created / 1000) >> 0;
      }
      if (user && user.hname) {
        intercomOptions.name = user.hname;
      }
      Intercom("update", intercomOptions);
    }
  }

  componentDidUpdate() {
    this.updateIntercomSettings();
  }

  componentWillUnmount() {
    this.state.mql.removeListener(this.mediaQueryChanged.bind(this));
  }

  mediaQueryChanged() {
    this.setState({ sidebarDocked: this.state.mql.matches });
  }

  onSetSidebarOpen(open) {
    this.setState({ sidebarOpen: open });
  }

  handleMenuButtonClick() {
    this.setState({ sidebarOpen: !this.state.sidebarOpen });
  }
  getTitleFromRoute() {
    /* ugly, but... is what it is for now */
    let title = "Admin Dashboard"; /* in leiu of default */

    if (this.props.routes[1] && this.props.routes[1].path === "integrate") {
      title = "Integrate";
    } else if (this.props.routes[1] && !this.props.routes[1].path) {
      title = "My Conversations";
    } else if (this.props.routes[1] && this.props.routes[1].path === "account") {
      title = "Account Management";
    } else if (this.props.routes[2] && this.props.routes[2].path === "comments") {
      title = "Moderate Comments";
    } else if (this.props.routes[2] && !this.props.routes[2].path) {
      title = "Configure Conversation";
    } else if (this.props.routes[2] && this.props.routes[2].path === "participants") {
      title = "Moderate Participants";
    } else if (this.props.routes[2] && this.props.routes[2].path === "stats") {
      title = "Conversation Statistics";
    } else if (this.props.routes[2] && this.props.routes[2].path === "export") {
      title = "Data Export";
    } else if (this.props.routes[2] && this.props.routes[2].path === "share") {
      title = "Distribute";
    } else if (this.props.routes[2] && this.props.routes[2].path === "reports") {
      title = "Reports";
    } else if (this.props.routes[2] && this.props.routes[2].path === "live") {
      title = "See Conversation Live";
    } else if (this.props.routes[2] && this.props.routes[2].path === "summary") {
      title = "Summary";
    }

    return title;
  }
  onSidebarItemClicked() {
    this.setState({ sidebarOpen: false });
  }

  renderConsole() {
    // let sidebar = null;
    // if (this.props.params.report_id) {
    //   sidebar = (
    //     <SidebarContentReport
    //       {...this.props}
    //       onSidebarItemClicked={this.onSidebarItemClicked.bind(this)}
    //     />
    //   );
    // } else if (this.props.params.conversation_id) {
    //   sidebar = (
    //     <SidebarContentConversation
    //       {...this.props}
    //       conversation_id={this.props.params.conversation_id}
    //       onSidebarItemClicked={this.onSidebarItemClicked.bind(this)}
    //     />
    //   );
    // } else {
    //   sidebar = (
    //     <SidebarContentHome
    //       {...this.props}
    //       onSidebarItemClicked={this.onSidebarItemClicked.bind(this)}
    //     />
    //   );
    // }
    // sidebar = sidebar
    //   open={this.state.sidebarOpen}
    //   docked={this.state.sidebarDocked}
    //   onSetOpen={this.onSetSidebarOpen.bind(this)}
    //     handleHamburgerClick={this.handleMenuButtonClick.bind(this)}
    //     showHamburger={this.state.sidebarDocked}
    //     name={this.props.user.hname}
    //     title={this.getTitleFromRoute()}
    //  style={styles.container}></div>
  }
  renderSpinner() {
    return <Flex styleOverrides={{ height: "100%" }}>{"Loading pol.is..."}</Flex>;
  }
  render() {
    if (!this.props.isLoggedIn) {
      return this.renderSpinner();
    }

    return (
      <>
        <li>
          <Link to="/">conversations</Link>
        </li>
        <li>
          <Link to="integrate"> integrate </Link>
        </li>
        <li>
          <Link to="account"> account </Link>
        </li>
        <li>
          <Link to="home"> home </Link>
        </li>
        <li>
          <Link to="signin"> signin </Link>
        </li>
        <li>
          <Link to="signin/*"> signin </Link>
        </li>
        <li>
          <Link to="signin/**/*"> signin </Link>
        </li>
        <li>
          <Link to="signout"> signout </Link>
        </li>
        <li>
          <Link to="signout/*"> signout </Link>
        </li>
        <li>
          <Link to="signout/**/*"> signout </Link>
        </li>
        <li>
          <Link to="createuser"> createuser </Link>
        </li>
        <li>
          <Link to="createuser/*"> createuser </Link>
        </li>
        <li>
          <Link to="createuser/**/*"> createuser </Link>
        </li>
        <li>
          <Link to="pwreset/*"> pwreset </Link>
        </li>
        <li>
          <Link to="pwresetinit"> pwresetinit </Link>
        </li>
        <li>
          <Link to="pwresetinit/done"> pwresetinit </Link>
        </li>
        <li>
          <Link to="tos"> tos </Link>
        </li>
        <li>
          <Link to="privacy"> privacy </Link>
        </li>
        <Switch>
          <Route exact path="/home" component={Home} />
          <Route exact path="/" component={Conversations} />
          <Route exact path="/account" component={Account} />

          <Route exact path="/integrate" component={Integrate} />

          <Route exact path="/signin" component={SignIn} />
          <Route exact path="/signout" component={SignOut} />
          <Route exact path="/createuser" component={CreateUser} />
          <Route exact path="/createuser/*" component={CreateUser} />

          <Route exact path="/createuser/**/*" component={CreateUser} />
          <Route exact path="/pwreset/*" component={PasswordReset} />
          <Route exact path="/pwresetinit" component={PasswordResetInit} />
          <Route exact path="/pwresetinit/done" component={PasswordResetInitDone} />
          <Route exact path="/tos" component={TOS} />
          <Route exact path="/privacy" component={Privacy} />
        </Switch>
      </>
    );
  }
}

export default App;

// import Container from "./components/container";

// // /conversation-admin
// import ConversationAdminContainer from "./components/conversation-admin/container";

// import ConversationConfig from "./components/conversation-admin/conversation-config";
// import ConversationStats from "./components/conversation-admin/conversation-stats";

// import ModerateComments from "./components/conversation-admin/moderate-comments";
// import ModerateCommentsTodo from "./components/conversation-admin/moderate-comments-todo";
// import ModerateCommentsAccepted from "./components/conversation-admin/moderate-comments-accepted";
// import ModerateCommentsRejected from "./components/conversation-admin/moderate-comments-rejected";
// import ModerateCommentsSeed from "./components/conversation-admin/moderate-comments-seed";
// import ModerateCommentsSeedTweet from "./components/conversation-admin/moderate-comments-seed-tweet";

// import ParticipantModeration from "./components/conversation-admin/moderate-people";
// import ParticipantModerationDefault from "./components/conversation-admin/moderate-people-default";
// import ParticipantModerationFeatured from "./components/conversation-admin/moderate-people-featured";
// import ParticipantModerationHidden from "./components/conversation-admin/moderate-people-hidden";

// import DataExport from "./components/conversation-admin/data-export";
// import ShareAndEmbed from "./components/conversation-admin/share-and-embed";
// import Live from "./components/conversation-admin/live";
// import Summary from "./components/conversation-admin/summary";

// import Reports from "./components/conversation-admin/reports";
// import ReportConfig from "./components/conversation-admin/report-config";
// import ReportComments from "./components/conversation-admin/report-comments";
// import ReportCommentsIncluded from "./components/conversation-admin/report-comments-included";
// import ReportCommentsExcluded from "./components/conversation-admin/report-comments-excluded";
// import ReportsList from "./components/conversation-admin/reports-list";

//     <Route path="m/:conversation_id" component={ConversationAdminContainer}>
//       <Route component={ConversationConfig} />
//       <Route path="live" component={Live} />
//       <Route path="share" component={ShareAndEmbed} />
//       <Route path="summary" component={Summary} />
//       <Route path="reports" component={Reports}>
//         <Route exact component={ReportsList} />
//         <Route path=":report_id" component={Container}>
//           <Route exact component={ReportConfig} />
//           <Route path="comments" component={ReportComments}>
//             <Route exact component={ReportCommentsIncluded} />
//             <Route path="included" component={ReportCommentsIncluded} />
//             <Route path="excluded" component={ReportCommentsExcluded} />
//           </Route>
//         </Route>
//       </Route>
//       <Route path="reports" component={Reports} />
//       <Route path="comments" component={ModerateComments}>
//         <Route component={ModerateCommentsTodo} />
//         <Route path="accepted" component={ModerateCommentsAccepted} />
//         <Route path="rejected" component={ModerateCommentsRejected} />
//         <Route path="seed" component={ModerateCommentsSeed} />
//         <Route path="seed_tweet" component={ModerateCommentsSeedTweet} />
//       </Route>
//       <Route path="participants" component={ParticipantModeration}>
//         <Route component={ParticipantModerationDefault} />
//         <Route path="featured" component={ParticipantModerationFeatured} />
//         <Route path="hidden" component={ParticipantModerationHidden} />
//       </Route>
//       <Route path="stats" component={ConversationStats} />
//       <Route path="export" component={DataExport} />
//     </Route>
//   </Route>
// </Switch>
