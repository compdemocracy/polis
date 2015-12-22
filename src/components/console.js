import React from "react";
import { connect } from "react-redux";
import { populateUserStore } from '../actions'
import Radium from "radium";
import _ from "lodash";
import {Link} from "react-router";
import Spinner from "./framework/spinner";
import Awesome from "react-fontawesome";
import Sidebar from "react-sidebar";
import SidebarContentConversation from "./sidebar-content-conversation";
import SidebarContentHome from "./sidebar-content-home";
import MaterialTitlePanel from './material-title-panel';
import Trial from "./framework/trial-banner";

@connect(state => state.user)
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
    this.props.dispatch(populateUserStore())
  }

  componentWillMount () {
    this.loadUserData()
    var mql = window.matchMedia(`(min-width: 800px)`);
    mql.addListener(this.mediaQueryChanged.bind(this));
    this.setState({mql: mql, docked: mql.matches});
  }

  componentDidMount () {
    this.mediaQueryChanged()
  }

  initIntercom  () {
    if (!this.intercomInitialized) {
      var user = this.props.user;
      if (user) {
        if (!window.Intercom && user && user.uid) {
            window.initIntercom();
        }
        if (user.email) {
          /*eslint-disable */
          /* jshint ignore:start */
          Intercom('boot', {
            app_id: 'nb5hla8s',
            created_at: Date.now(),
            user_id: user.uid
          });
          /* jshint ignore:end */
          /*eslint-enable */
        }
        this.intercomInitialized = true;
      }
    }
  }

  updateIntercomSettings  () {
    this.initIntercom();
    var user = this.props.user;

    window.intercomOptions = {
        app_id: 'nb5hla8s',
        widget: {
          activator: '#IntercomDefaultWidget'
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

  }

  componentDidUpdate () {
    this.updateIntercomSettings();
  }

  componentWillUnmount () {
    this.state.mql.removeListener(this.mediaQueryChanged.bind(this));
  }

  mediaQueryChanged () {
    this.setState({sidebarDocked: this.state.mql.matches});
  }

  onSetSidebarOpen (open) {
    this.setState({sidebarOpen: open});
  }

  handleMenuButtonClick () {
    this.setState({sidebarOpen: !this.state.sidebarOpen})
  }
  getTitleFromRoute () {
    /* ugly, but... is what it is for now */
    let title = "Admin Dashboard"; /* in leiu of default */

    if (this.props.routes[1] && this.props.routes[1].path === "integrate") {
      title = "Integrate";
    } else if (this.props.routes[1] && this.props.routes[1].path === "conversations") {
      title = "My Conversations";
    } else if (this.props.routes[1] && this.props.routes[1].path === "account") {
      title = "Account Management";
    } else if (this.props.routes[2] && this.props.routes[2].path === "comments") {
      title = "Moderate Comments";
    } else if (this.props.routes[2] && this.props.routes[2].path === "participants") {
      title = "Moderate Participants";
    } else if (this.props.routes[2] && this.props.routes[2].path === "stats") {
      title = "Conversation Statistics";
    }

    return title;
  }
  render() {
    return (
      <Sidebar
        sidebar={
          this.props.params.conversation_id ?
            <SidebarContentConversation conversation_id={this.props.params.conversation_id}/> :
            <SidebarContentHome/>
        }
        open={ this.state.sidebarOpen }
        docked={ this.state.sidebarDocked }
        onSetOpen={ this.onSetSidebarOpen.bind(this) }>
        <MaterialTitlePanel
          handleHamburgerClick={this.handleMenuButtonClick.bind(this)}
          showHamburger={this.state.sidebarDocked}
          title={this.getTitleFromRoute()}>
          {/*trial condition*/ true ? <Trial title={"You have x days remaining on your trial. *Upgrade*"}/> : ""}
            <div>
              { this.props.children }
            </div>
        </MaterialTitlePanel>
      </Sidebar>
    );
  }
}

export default App;
