import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import { Link } from "react-router";

@Radium
class ModeratePeople extends React.Component {

  render() {
    const m = "/m/"+this.props.params.conversation+"/participants/";
    return (
      <div>
        <h1>Moderate Participants</h1>
        <div>
          "Moderate Participants"
          <p>
            We automatically decide who to show in the visualization, but you can override that here. The visualization will differ per user based on whether they have Facebook friends participating. Here’s how we prioritize who gets shown:
          </p>
          <ul>
            <li> Facebook friends </li>
            <li> Participants with verified Twitter accounts </li>
            <li> Participants with highest number of Twitter followers </li>
            <li> Participants with Facebook connected </li>
          </ul>
          <p> Featured participants are always shown. Hidden participants are only shown to Facebook friends. </p>
        </div>
          <Link to={m + "default"}> {"Default"} </Link>
          <Link to={m + "featured"}> {"Featured"} </Link>
          <Link to={m + "hidden"}> {"Hidden"} </Link>
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
