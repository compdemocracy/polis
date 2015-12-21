import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import { handleZidMetadataUpdate } from "../../actions";
import Checkbox from "material-ui/lib/checkbox";
import InputField from "material-ui/lib/text-field";
import settings from "../../settings";
import Spinner from "../framework/spinner";

/* check if refer came from 'new' and if it did, show modal saying 'get started by...' */

@connect(state => state.zid_metadata)
@Radium
class ConversationConfig extends React.Component {

  handleBoolValueChange (field) {
    return () => {
      this.props.dispatch(
        handleZidMetadataUpdate(
          this.props.zid_metadata,
          field,
          this.refs[field].isChecked()
        )
      )
    }
  }

  transformBoolToInt(value) {
    return value ? 1 : 0;
  }

  handleIntegerBoolValueChange (field) {
    return () => {
      this.props.dispatch(
        handleZidMetadataUpdate(
          this.props.zid_metadata,
          field,
          this.transformBoolToInt(this.refs[field].isChecked())
        )
      )
    }
  }

  handleStringValueChange (field) {
    return () => {
      this.props.dispatch(
        handleZidMetadataUpdate(
          this.props.zid_metadata,
          field,
          this.refs[field].getValue()
        )
      )
    }
  }

  render() {
    return (
      <div>
        <h1>Conversation config</h1>
        {this.props.loading ? <Spinner/> : "Up to date"}
        {this.props.error ? "error" : ""}
        <div>
          <InputField
            ref={"topic"}
            onBlur={this.handleStringValueChange("topic").bind(this)}
            floatingLabelText="Topic"
            defaultValue={this.props.zid_metadata.topic}
            multiLine={true} />
        </div>
        <div>
          <InputField
            hintText="Can include markdown!"
            ref={"description"}
            onBlur={this.handleStringValueChange("description").bind(this)}
            floatingLabelText="Description"
            defaultValue={this.props.zid_metadata.description}
            multiLine={true} />
        </div>
        <div style={{maxWidth: 400, marginTop: 40}}>
          <h3> Customize the User Interface </h3>
          <Checkbox
            label="Visualization"
            ref={"vis_type"}
            checked={ this.props.zid_metadata.vis_type === 1 ? true : false }
            onCheck={ this.handleIntegerBoolValueChange("vis_type").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> participants can see the visualization </p>
          <Checkbox
            label="Comment form"
            ref={"write_type"}
            checked={this.props.zid_metadata.write_type === 1 ? true : false}
            onCheck={ this.handleIntegerBoolValueChange("write_type").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Users can submit comments </p>
          <Checkbox
            label="Voting pane"
            ref={"upvotes"}
            disabled
            checked={this.props.zid_metadata.upvotes === 1 ? true : false}
            onCheck={ this.handleIntegerBoolValueChange("upvotes").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Users can vote on comments </p>
          <Checkbox
            label="Help text"
            ref={"help_type"}
            checked={this.props.zid_metadata.help_type === 1 ? true : false}
            onCheck={ this.handleIntegerBoolValueChange("help_type").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Show the two explanation modals above voting and the visualization </p>
          <Checkbox
            label="Social sharing buttons"
            ref={"socialbtn_type"}
            checked={this.props.zid_metadata.socialbtn_type === 1 ? true : false}
            onCheck={ this.handleIntegerBoolValueChange("socialbtn_type").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> </p>
          <Checkbox
            label="Facebook login prompt"
            ref={"auth_opt_fb"}
            checked={this.props.zid_metadata.auth_opt_fb}
            onCheck={ this.handleBoolValueChange("auth_opt_fb").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> </p>
          <Checkbox
            label="Twitter login prompt"
            ref={"auth_opt_tw"}
            checked={this.props.zid_metadata.auth_opt_tw}
            onCheck={ this.handleBoolValueChange("auth_opt_tw").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> </p>
          <Checkbox
            label="Gray background"
            ref={"bgcolor"}
            disabled
            checked={this.props.zid_metadata.bgcolor === null ? true : false}
            onCheck={ this.handleBoolValueChange("bgcolor").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}>
              {"Unchecked: white background"}
            </p>
          <h3> Schemes </h3>
          <Checkbox
            label="Strict Moderation"
            ref={"strict_moderation"}
            checked={ this.props.zid_metadata.strict_moderation }
            onCheck={ this.handleBoolValueChange("strict_moderation").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> no comments shown without moderator approval </p>
          <Checkbox
            label="Require Auth to Comment"
            ref={"auth_needed_to_write"}
            checked={this.props.zid_metadata.auth_needed_to_write}
            onCheck={ this.handleBoolValueChange("auth_needed_to_write").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Users cannot submit comments without first connecting either Facebook or Twitter </p>
          <Checkbox
            label="Require Auth to Vote"
            ref={"auth_needed_to_vote"}
            checked={this.props.zid_metadata.auth_needed_to_vote}
            onCheck={ this.handleBoolValueChange("auth_needed_to_vote").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Users cannot vote without first connecting either Facebook or Twitter </p>
          <Checkbox
            label="Preserve Anonymity"
            ref={"is_anon"}
            disabled
            checked={this.props.zid_metadata.is_anon}
            onCheck={ this.handleBoolValueChange("is_anon").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Disables visualization, does not transmit any participant statistics to you, requires social authorization for both writing and voting. </p>
        </div>
        <div>
          <InputField
            ref={"style_btn"}
            onBlur={this.handleStringValueChange("style_btn").bind(this)}
            hintText="ie., #e63082"
            defaultValue={this.props.zid_metadata.style_btn}
            floatingLabelText="Customize submit button color"
            multiLine={true} />
        </div>
        <div>
          <InputField
            ref={"help_bgcolor"}
            disabled
            onBlur={this.handleStringValueChange("help_bgcolor").bind(this)}
            defaultValue={this.props.zid_metadata.help_bgcolor}
            hintText="ie., #e63082"
            floatingLabelText="Customize help text background"
            multiLine={true} />
        </div>
        <div>
          <InputField
            ref={"help_color"}
            disabled
            onBlur={this.handleStringValueChange("help_color").bind(this)}
            defaultValue={this.props.zid_metadata.help_color}
            hintText="ie., #e63082"
            floatingLabelText="Customize help text color"
            multiLine={true} />
        </div>
      </div>
    );
  }
}

export default ConversationConfig;

// <Checkbox
//   label="Read Only"
//   disabled
//   checked={false}
//   onCheck={ () => {console.log("this should be an action")} }
//   labelPosition={"left"}
//   labelWrapperColor={settings.darkerGray}/>
//   <p style={{fontSize: 10, fontStyle: "italic"}}> Disables writing and commenting, enables visualization. </p>
