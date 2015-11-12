import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import { Link } from "react-router";

@connect(state => state.data)
@Radium
class CommentModeration extends React.Component {

  render() {
    return (
      <div>
        <h1>Moderate Comments</h1>
        <div>
          "Moderate Comments"
        </div>
          <Link to="comments/todo">Todo </Link>
          <Link to="comments/accepted">Accepted </Link>
          <Link to="comments/rejected">Rejected </Link>
          <Link to="comments/seed">Seed </Link>

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
