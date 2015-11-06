import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

@connect(state => state.data)
@Radium
class ConversationConfig extends React.Component {

  render() {
    return (
      <div>
        <h1>Conversation config</h1>
        <div>
          "Conversation Config"
        </div>
      </div>
    );
  }
}

export default ConversationConfig;
