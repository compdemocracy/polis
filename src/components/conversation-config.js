import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Checkbox from "./framework/checkbox";
import settings from "../settings";

@connect(state => state.data)
@Radium
class ConversationConfig extends React.Component {

  render() {
    return (
      <div>
        <h1>Conversation config</h1>
        <Checkbox
          label="Strict Moderation"
          helpText="no comments shown without approval"
          clickHandler={ () => {console.log("this should be an action")} }
          labelWrapperColor={settings.darkerGray}
          color={settings.polisBlue}/>
        <Checkbox
          label="Visualization"
          helpText="participants can see the visualization"
          clickHandler={ () => {console.log("this should be an action")} }
          labelWrapperColor={settings.darkerGray}
          color={settings.polisBlue}/>
        <Checkbox
          label="Comments"
          helpText="Users can submit comments"
          clickHandler={ () => {console.log("this should be an action")} }
          labelWrapperColor={settings.darkerGray}
          color={settings.polisBlue}/>
        <Checkbox
          label="Voting"
          helpText="Users can vote"
          clickHandler={ () => {console.log("this should be an action")} }
          labelWrapperColor={settings.darkerGray}
          color={settings.polisBlue}/>
        <Checkbox
          label="Foo"
          helpText="Bar"
          clickHandler={ () => {console.log("this should be an action")} }
          labelWrapperColor={settings.darkerGray}
          color={settings.polisBlue}/>
        <Checkbox
          label="Baz"
          helpText="Qux"
          clickHandler={ () => {console.log("this should be an action")} }
          labelWrapperColor={settings.darkerGray}
          color={settings.polisBlue}/>
        <h3> Download all statistics </h3>

      </div>
    );
  }
}

export default ConversationConfig;
