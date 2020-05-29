// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
/** @jsx jsx */

import React from "react";
import { connect } from "react-redux";
import { populateUserStore } from "./actions";

import _ from "lodash";

import { Switch, Route, Link, Redirect } from "react-router-dom";
import { Flex, Box, jsx } from "theme-ui";

/* landers */
import Home from "./components/landers/home";
import TOS from "./components/landers/tos";
import Privacy from "./components/landers/privacy";
import PasswordReset from "./components/landers/password-reset";
import PasswordResetInit from "./components/landers/password-reset-init";
import PasswordResetInitDone from "./components/landers/password-reset-init-done";
import SignIn from "./components/landers/signin";
import SignOut from "./components/landers/signout";
import CreateUser from "./components/landers/createuser";

// /conversation-admin
import ConversationAdminContainer from "./components/conversation-admin/index";

import Conversations from "./components/conversations-and-account/conversations";
import Account from "./components/conversations-and-account/account";
import Integrate from "./components/conversations-and-account/integrate";

import InteriorHeader from "./components/interior-header";

const PrivateRoute = ({ component: Component, nameee, authed, ...rest }) => {
  console.log("inside privateroute, authed:", nameee, authed);
  return (
    <Route
      {...rest}
      render={(props) =>
        authed === true ? (
          <Component {...props} />
        ) : (
          <Redirect to={{ pathname: "/signin", state: { from: props.location } }} />
        )
      }
    />
  );
};

@connect((state) => {
  return state.user;
})
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
  }

  isAuthed(props) {
    const { location } = this.props;
    let authed = false;

    if (!_.isUndefined(props.isLoggedIn) && props.isLoggedIn) {
      authed = true;
    }

    if ((props.error && props.status === 401) || props.status === 403) {
      authed = false;
    }

    console.log("authed? ", authed, this.props);
    return authed;
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
    // if (!this.props.isLoggedIn) {
    //   return this.renderSpinner();
    // }

    return (
      <>
        <Switch>
          <Route exact path="/home" component={Home} />

          <Route exact path="/signin" component={SignIn} />
          <Route exact path="/signin/*" component={SignIn} />
          <Route exact path="/signin/**/*" component={SignIn} />
          <Route exact path="/signout" component={SignOut} />
          <Route exact path="/signout/*" component={SignOut} />
          <Route exact path="/signout/**/*" component={SignOut} />
          <Route exact path="/createuser" component={CreateUser} />
          <Route exact path="/createuser/*" component={CreateUser} />
          <Route exact path="/createuser/**/*" component={CreateUser} />

          <Route exact path="/pwreset" component={PasswordReset} />
          <Route path="/pwreset/*" component={PasswordReset} />
          <Route exact path="/pwresetinit" component={PasswordResetInit} />
          <Route exact path="/pwresetinit/done" component={PasswordResetInitDone} />
          <Route exact path="/tos" component={TOS} />
          <Route exact path="/privacy" component={Privacy} />

          <InteriorHeader>
            <Route
              render={(routeProps) => {
                if (routeProps.location.pathname.split("/")[1] === "m") {
                  return null;
                }
                return (
                  <Flex>
                    <Box sx={{ mr: [5], p: [4], flex: "0 0 auto" }}>
                      <Box sx={{ mb: [3] }}>
                        <Link sx={{ variant: "links.nav" }} to={`/`}>
                          Conversations
                        </Link>
                      </Box>
                      <Box sx={{ mb: [3] }}>
                        <Link sx={{ variant: "links.nav" }} to={`/integrate`}>
                          Integrate
                        </Link>
                      </Box>
                      <Box sx={{ mb: [3] }}>
                        <Link sx={{ variant: "links.nav" }} to={`/account`}>
                          Account
                        </Link>
                      </Box>
                    </Box>
                    <Box sx={{ p: [4], flex: "0 0 auto", maxWidth: "35em", mx: [4] }}>
                      <PrivateRoute
                        authed={this.isAuthed(this.props)}
                        exact
                        nameee="empty slash"
                        path="/"
                        component={Conversations}
                      />
                      <PrivateRoute
                        authed={this.isAuthed(this.props)}
                        exact
                        nameee="account page"
                        path="/account"
                        component={Account}
                      />
                      <PrivateRoute
                        authed={this.isAuthed(this.props)}
                        exact
                        nameee="integrate page"
                        path="/integrate"
                        component={Integrate}
                      />
                    </Box>
                  </Flex>
                );
              }}
            />

            <PrivateRoute
              path="/m/:conversation_id"
              nameee="m interior page for convo"
              authed={this.isAuthed(this.props)}
              component={ConversationAdminContainer}
            />
          </InteriorHeader>
        </Switch>
      </>
    );
  }
}

export default App;
