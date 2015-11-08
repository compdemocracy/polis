import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import {Link} from "react-router"

import Sidebar from "react-sidebar";

@connect(state => state.data)
@Radium
class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      sidebarOpen: false,
      sidebarDocked: true,
      conversationSelected: false
    };
  }

  componentWillMount () {
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
    console.log(this)
    this.setState({sidebarOpen: open});
  }

  handleMenuButtonClick () {
    this.setState({sidebarOpen: !this.state.sidebarOpen})
  }

  render() {
    const conversationSidebarContent = (
      <div style={{marginLeft: 10}}>
        <h3 style={{marginRight: 10}}> Conversation Admin </h3>
        <p> <em> pol.is/55555 </em> </p>
        <p><Link style={{marginRight: 15}} to="stats">Stats</Link></p>
        <p><Link style={{marginRight: 15}} to="config">Config</Link></p>
        <p><Link style={{marginRight: 15}} to="comments">Comments</Link></p>
        <p><Link style={{marginRight: 15}} to="participants">Participants</Link></p>
      </div>
    )
    const homeSidebarContent = (
      <div style={{marginLeft: 10}}>
        <h3 style={{marginRight: 10}}> Polis Home </h3>
        <p> <em> logged in user </em> </p>
        <p><Link style={{marginRight: 15}} to="inbox">Inbox</Link></p>
        <p><Link style={{marginRight: 15}} to="home-stats">Overall Stats</Link></p>
        <p><a style={{marginRight: 15}} href="http://about.pol.is">Docs</a></p>
        <p><Link style={{marginRight: 15}} to="account">Account</Link></p>
      </div>
    )
    return (
      <Sidebar sidebar={this.state.conversationSelected ? conversationSidebarContent : homeSidebarContent}
        open={this.state.sidebarOpen}
        docked={this.state.sidebarDocked}
        onSetOpen={this.onSetSidebarOpen.bind(this)}>
        <div style={{width: 800, margin: 40}}>
          <div>
            <p
              onClick={this.handleMenuButtonClick.bind(this)}
              style={{marginRight: 15, display: "inline"}}>
              |||||||||
            </p>
          </div>
          {this.props.children}
        </div>
      </Sidebar>

    );
  }
}

const styles = {
  backgroundColor: `hsla(${Math.random() * 255}, 50%, 50%, ${Math.random()})`,
  padding: '5px',
  color: 'white',
  border: 0,
  ':hover': {
    backgroundColor: 'blue'
  }
};

export default App;
