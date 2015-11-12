import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

@connect(state => state.data)
@Radium
class CreateConversation extends React.Component {
  render() {
    return (
      <div>
        <h1>CreateConversation</h1>
        <div>
          "CreateConversation"
        </div>
      </div>
    );
  }
}

export default CreateConversation;