import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import { Link } from "react-router";

// @connect(state => state.data)
@Radium
class ModeratePeople extends React.Component {

  render() {
    return (
      <div>
        <h1>Moderate People</h1>
        <div>
          "Moderate People"
        </div>
          <Link to="participants/default">Default </Link>
          <Link to="participants/featured">Featured </Link>
          <Link to="participants/hidden">Hidden </Link>
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

export default ModeratePeople;
