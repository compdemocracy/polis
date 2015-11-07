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
      sidebarDocked: true
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
    const sidebarContent = <b>Sidebar content</b>;
    return (
      <Sidebar sidebar={sidebarContent}
               open={this.state.sidebarOpen}
               docked={this.state.sidebarDocked}
               onSetOpen={this.onSetSidebarOpen.bind(this)}>
        <div>
          <div>
            <p
              onClick={this.handleMenuButtonClick.bind(this)}
              style={{marginRight: 15, display: "inline"}}>
              |||||||||
              </p>
            <Link style={{marginRight: 15}} to="comments">Comments</Link>
            <Link style={{marginRight: 15}} to="participants">Participants</Link>
            <Link style={{marginRight: 15}} to="config">Config</Link>
            <Link style={{marginRight: 15}} to="stats">Stats</Link>
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
