import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import {Link} from "react-router"

import Sidebar from "react-sidebar";

@connect(state => state.data)
@Radium
class App extends React.Component {

  render() {
    return (
      <div>
        <div>
          <Link to="comments">Comments </Link>
          <Link to="participants">Participants </Link>
          <Link to="config">Config </Link>
          <Link to="stats">Stats </Link>
        </div>
        {this.props.children}
      </div>
    );
  }
}

var styles = {
  backgroundColor: `hsla(${Math.random() * 255}, 50%, 50%, ${Math.random()})`,
  padding: '5px',
  color: 'white',
  border: 0,
  ':hover': {
    backgroundColor: 'blue'
  }
};

export default App;
