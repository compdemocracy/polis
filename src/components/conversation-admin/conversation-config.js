import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Checkbox from "material-ui/lib/checkbox";
import InputField from "material-ui/lib/text-field";
import settings from "../../settings";

/* check if refer came from 'new' and if it did, show modal saying 'get started by...' */

@connect(state => state.zid_metadata)
@Radium
class ConversationConfig extends React.Component {

  render() {
    return (
      <div>
        <h1>Conversation config</h1>
        <button> Save </button>
        <div>
          <InputField
            floatingLabelText="Topic"
            value={this.props.zid_metadata.topic}
            multiLine={true} />
        </div>
        <div>
          <InputField
            hintText="Can include markdown!"
            floatingLabelText="Description"
            value={this.props.zid_metadata.description}
            multiLine={true} />
        </div>
        <div style={{maxWidth: 400, marginTop: 40}}>
          <h3> Customize the User Interface </h3>
          <Checkbox
            label="Visualization"
            checked={this.props.zid_metadata.vis_type === 1 ? true : false}
            clickHandler={ () => {console.log("this should be an action")} }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> participants can see the visualization </p>
          <Checkbox
            label="Comment form"
            checked={this.props.zid_metadata.write_type === 1 ? true : false}
            clickHandler={ () => {console.log("this should be an action")} }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Users can submit comments </p>
          <Checkbox
            label="Voting pane"
            checked={this.props.zid_metadata.upvotes === 1 ? true : false}
            clickHandler={ () => {console.log("this should be an action")} }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Users can vote on comments </p>
          <Checkbox
            label="Help text"
            checked={this.props.zid_metadata.help_type === 1 ? true : false}
            clickHandler={ () => {console.log("this should be an action")} }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Show the two explanation modals above voting and the visualization </p>
          <Checkbox
            label="Social sharing buttons"
            checked={this.props.zid_metadata.socialbtn_type === 1 ? true : false}
            clickHandler={ () => {console.log("this should be an action")} }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> </p>
          <Checkbox
            label="Facebook login prompt"
            checked={this.props.zid_metadata.auth_opt_fb}
            clickHandler={ () => {console.log("this should be an action")} }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> </p>
          <Checkbox
            label="Twitter login prompt"
            checked={this.props.zid_metadata.auth_opt_tw}
            clickHandler={ () => {console.log("this should be an action")} }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> </p>
          <Checkbox
            label="Gray background"
            checked={this.props.zid_metadata.bgcolor === null ? true : false}
            clickHandler={ () => {console.log("this should be an action")} }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}>
              {"Unchecked: white background"}
            </p>
          <h3> Schemes </h3>
          <Checkbox
            label="Strict Moderation"
            checked={this.props.zid_metadata.strict_moderation}
            clickHandler={ () => {console.log("this should be an action")} }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> no comments shown without moderator approval </p>
          <Checkbox
            label="Require Auth to Comment"
            checked={this.props.zid_metadata.auth_needed_to_write}
            clickHandler={ () => {console.log("this should be an action")} }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Users cannot submit comments without first connecting either Facebook or Twitter </p>
          <Checkbox
            label="Require Auth to Vote"
            checked={this.props.zid_metadata.auth_needed_to_vote}
            clickHandler={ () => {console.log("this should be an action")} }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Users cannot vote without first connecting either Facebook or Twitter </p>
          <Checkbox
            label="Preserve Anonymity"
            checked={this.props.zid_metadata.is_anon}
            clickHandler={ () => {console.log("this should be an action")} }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={"rgb(255,0,0)"}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Disables visualization, does not transmit any participant statistics to you, requires social authorization for both writing and voting. </p>
          <Checkbox
            label="Read Only"
            checked={false}
            clickHandler={ () => {console.log("this should be an action")} }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={"rgb(255,0,0)"}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Disables writing and commenting, enables visualization. </p>
        </div>
        <div>
          <InputField
            hintText="ie., #e63082"
            value={this.props.zid_metadata.style_btn}
            floatingLabelText="Customize submit button color"
            multiLine={true} />
        </div>
        <div>
          <InputField
            value={this.props.zid_metadata.help_bgcolor}
            hintText="ie., #e63082"
            floatingLabelText="Customize help text background"
            multiLine={true} />
        </div>
        <div>
          <InputField
            value={this.props.zid_metadata.help_color}
            hintText="ie., #e63082"
            floatingLabelText="Customize help text color"
            multiLine={true} />
        </div>
      </div>
    );
  }
}

export default ConversationConfig;
