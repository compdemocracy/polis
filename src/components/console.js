// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import { populateUserStore } from "../actions";

import Radium from "radium";
import _ from "lodash";
// import {Link} from "react-router";
import StarsSpinner from "./framework/stars-spinner";
// import Awesome from "react-fontawesome";
import Sidebar from "react-sidebar";
import SidebarContentConversation from "./sidebar-content-conversation";
import SidebarContentHome from "./sidebar-content-home";
import SidebarContentReport from "./sidebar-content-report";
import MaterialTitlePanel from "./material-title-panel";
import Trial from "./framework/trial-banner";
import Flex from "./framework/flex";

const styles = {
  container: {
    backgroundColor: "rgb(240,240,247)",
    height: "100%",
    margin: 0
  }
};

@connect((state) => {
  return state.user;
})
@Radium
class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      sidebarOpen: false
      // sidebarDocked: true,
    };
  }
  static propTypes = {
    /* react */
    dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    /* component api */
    error: React.PropTypes.object,
    loading: React.PropTypes.bool,
    user: React.PropTypes.object,
    routes: React.PropTypes.array,
    isLoggedIn: React.PropTypes.bool,
    // foo: React.PropTypes.string
  }
  static defaultProps = {
    // foo: "bar"
  }

  loadUserData() {
    this.props.dispatch(populateUserStore());
  }

  componentWillMount() {
    this.loadUserData();
    let mql = window.matchMedia(`(min-width: 800px)`);
    mql.addListener(this.mediaQueryChanged.bind(this));
    this.setState({mql: mql, docked: mql.matches});
    this.checkForAuth(this.props);
  }

  componentWillReceiveProps(nextProps) {
    this.checkForAuth(nextProps);
  }

  checkForAuth(props) {
    if (!_.isUndefined(props.isLoggedIn)) {

      var shouldRedirect = props.error ?
        (props.status === 401 || props.status === 403) :
        !props.isLoggedIn;

      if (shouldRedirect) {
        window.location = "/signin" + this.props.location.pathname;
      }
    }
  }

  componentDidMount() {
    this.mediaQueryChanged();
  }

  initIntercom() {
    if (!this.intercomInitialized) {
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
            created_at: user.created / 1000 >> 0,
            user_id: user.uid
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
          activator: "#IntercomDefaultWidget"
        }
      };
      if (user && user.uid) {
        intercomOptions.user_id = user.uid + "";
      }
      if (user && user.email) {
        intercomOptions.email = user.email;
      }
      if (user && user.created) {
        intercomOptions.created_at = user.created / 1000 >> 0;
      }
      if (user && user.hname) {
        intercomOptions.name = user.hname;
      }
      Intercom('update', intercomOptions);
    }
  }

  componentDidUpdate() {
    this.updateIntercomSettings();
  }

  componentWillUnmount() {
    this.state.mql.removeListener(this.mediaQueryChanged.bind(this));
  }

  mediaQueryChanged() {
    this.setState({sidebarDocked: this.state.mql.matches});
  }

  onSetSidebarOpen(open) {
    this.setState({sidebarOpen: open});
  }

  handleMenuButtonClick() {
    this.setState({sidebarOpen: !this.state.sidebarOpen});
  }
  getTitleFromRoute() {
    /* ugly, but... is what it is for now */
    let title = "Admin Dashboard"; /* in leiu of default */

    if (this.props.routes[1] && this.props.routes[1].path === "integrate") {
      title = "Integrate";
    } else if (this.props.routes[1] && !this.props.routes[1].path) {
      title = "My Conversations";
    } else if (this.props.routes[1] && this.props.routes[1].path === "other-conversations") {
      title = "Conversations I Participated In";
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
      title = "Share & Embed";
    } else if (this.props.routes[2] && this.props.routes[2].path === "live") {
      title = "See Conversation Live";
    } else if (this.props.routes[2] && this.props.routes[2].path === "summary") {
      title = "Summary";
    }

    return title;
  }
  onSidebarItemClicked() {
    this.setState({sidebarOpen: false});
  }

  renderConsole() {

    let sidebar = null;
    if (this.props.params.report_id) {
      sidebar = <SidebarContentReport
        {...this.props}
        onSidebarItemClicked={ this.onSidebarItemClicked.bind(this) } />;
    } else if (this.props.params.conversation_id) {
      sidebar = <SidebarContentConversation
        {...this.props}
        conversation_id={this.props.params.conversation_id}
        onSidebarItemClicked={ this.onSidebarItemClicked.bind(this) }/>;
    } else {
      sidebar = <SidebarContentHome
        {...this.props}
        onSidebarItemClicked={ this.onSidebarItemClicked.bind(this) } />;
    }

    return (
      <Sidebar
          sidebar={sidebar}
          open={ this.state.sidebarOpen }
          docked={ this.state.sidebarDocked }

          onSetOpen={ this.onSetSidebarOpen.bind(this) }>
          <MaterialTitlePanel
            handleHamburgerClick={this.handleMenuButtonClick.bind(this)}
            showHamburger={this.state.sidebarDocked}
            name={this.props.user.hname}
            title={this.getTitleFromRoute()}>
            {
              /*trial condition*/ true ?
              <Trial title={"You have x days remaining on your trial. *Upgrade*"}/> :
                ""
              }
              <div style={styles.container}>
                { this.props.children }
              </div>
            </MaterialTitlePanel>
      </Sidebar>
    )
  }
  renderSpinner() {
    return (
      <Flex styleOverrides={{height: "100%"}}>
        {"Loading pol.is..."}
      </Flex>
    )
    // return (
    //   <StarsSpinner
    //     text={""}
    //     nodeColor={ "rgb(150,150,150)" }
    //     count={ Math.floor(window.innerWidth / 10) }
    //     width={ window.innerWidth }
    //     height={ window.innerHeight }
    //     radius={ 1.5 }
    //     lineWidth={ 1 }/>
    // )
  }
  render() {
    return (
      <div style={{height: "100%"}}>
        {
          !this.props.isLoggedIn ? this.renderSpinner() : this.renderConsole()
        }
      </div>
    );
  }
}

export default App;
