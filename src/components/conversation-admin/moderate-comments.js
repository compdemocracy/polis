import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import { Link } from "react-router";

@Radium
class CommentModeration extends React.Component {

  render() {
    const m = "/m/"+this.props.params.conversation+"/comments/";
    return (
      <div>
        <h1>Moderate Comments</h1>
        <div>
          "Moderate Comments"
        </div>
          <Link to={m + "todo"}> Todo </Link>
          <Link to={m + "accepted"}> Accepted </Link>
          <Link to={m + "rejected"}> Rejected </Link>
          <Link to={m + "seed"}> Seed </Link>
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

export default CommentModeration;
