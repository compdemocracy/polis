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
      sidebarDocked: true,
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

  render() {
    return (
      <Sidebar
        sidebar={ this.props.params.conversation ? <SidebarContentConversation conversation_id={this.props.params.conversation}/> : <SidebarContentHome/> }
        open={ this.state.sidebarOpen }
        docked={ this.state.sidebarDocked }
        onSetOpen={ this.onSetSidebarOpen.bind(this) }>
        <MaterialTitlePanel title="Admin Dashboard">
          {/*trial*/ true ? <Trial title={"You have x days remaining on your trial. *Upgrade*"}/> : ""}
            <div style={{maxWidth: 800, margin: 20}}>
              {
                this.state.sidebarDocked ?
                  "" :
                  <div
                    onClick={this.handleMenuButtonClick.bind(this)}
                    style={{marginRight: 15, display: "inline", fontSize: 18, cursor: "pointer"}}>
                    <Awesome name="bars"/>
                    {" Menu"}
                  </div>
              }
              { this.props.children }
            </div>
        </MaterialTitlePanel>
      </Sidebar>
    );
  }
}

export default App;
