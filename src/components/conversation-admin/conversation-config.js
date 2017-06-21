// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import Features from "../../util/plan-features";
import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import { handleZidMetadataUpdate, optimisticZidMetadataUpdateOnTyping } from "../../actions";
import Checkbox from "material-ui/lib/checkbox";
import ComponentHelpers from "../../util/component-helpers";
import NoPermission from "./no-permission";
import InputField from "material-ui/lib/text-field";
import settings from "../../settings";
import Spinner from "../framework/spinner";
import Awesome from "react-fontawesome";

import ModerateCommentsSeed from "./moderate-comments-seed";
import ModerateCommentsSeedTweet from "./moderate-comments-seed-tweet";


/* check if refer came from 'new' and if it did, show modal saying 'get started by...' */

const cardPadding = 10;
const cardBorderRadius = 3;

const styles = {
  container: {
    backgroundColor: "rgb(240,240,247)",
    minHeight: "100vh",
    paddingBottom: 10
  },
  configCard: {
    margin: 10,
    maxWidth: 400,
    backgroundColor: "rgb(253,253,253)",
    borderRadius: cardBorderRadius,
    padding: cardPadding,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
  sectionHeader: {
    fontSize: 22,
    marginTop: 0,
    marginBottom: 0,
    fontWeight: 500,
    color: "rgb(160,160,160)"
  },
  notification: {
    fontSize: 16,
    fontWeight: 500,
    color: "rgb(160,160,160)"
  }
}

@connect(state => state.user)
@connect(state => state.zid_metadata)
@Radium
class ConversationConfig extends React.Component {

  handleBoolValueChange (field) {
    return () => {
      var val = this.refs[field].isChecked();
      if (field === "bgcolor") {
        // gray checked=default, unchecked white
        val = val ? "default" : "#fff";
      }
      this.props.dispatch(
        handleZidMetadataUpdate(
          this.props.zid_metadata,
          field,
          val
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
      var val = this.refs[field].getValue();
      if (field === "help_bgcolor" || field === "help_color") {
        if (!val.length) {
          val = "default";
        }
      }
      this.props.dispatch(
        handleZidMetadataUpdate(
          this.props.zid_metadata,
          field,
          this.refs[field].getValue()
        )
      )
    }
  }

  handleConfigInputTyping (field) {
    return (e) => {
      this.props.dispatch(
        optimisticZidMetadataUpdateOnTyping(
          this.props.zid_metadata,
          field,
          e.target.value
        )
      )
    }
  }

  render() {
    console.log(this.props);

    if (ComponentHelpers.shouldShowPermissionsError(this.props)) {
      return <NoPermission/>
    }

    return (
      <div style={styles.container}>
        <div style={styles.configCard}>
        {
          this.props.loading ?
            <div style={styles.notification}> <Awesome name="cloud-upload"/> <span>Saving</span> </div> :
            <div style={styles.notification}> <Awesome name="bolt"/> <span>Up to date</span> </div>
        }
        {this.props.error ? <div style={styles.notification}> <Awesome name="exclamation-circle"/> Error Saving </div> : ""}
        </div>
        <div style={styles.configCard}>
          <p style={styles.sectionHeader}>Topic</p>
          <InputField
            ref={"topic"}
            style={{width: 360}}
            onBlur={this.handleStringValueChange("topic").bind(this)}
            floatingLabelText="Topic"
            onChange={this.handleConfigInputTyping("topic")}
            value={this.props.zid_metadata.topic}
            multiLine={true} />
        </div>
        <div style={styles.configCard}>
          <p style={styles.sectionHeader}>Description</p>
          <InputField
            hintText="Can include markdown!"
            style={{width: 360}}
            ref={"description"}
            onBlur={this.handleStringValueChange("description").bind(this)}
            floatingLabelText="Description"
            onChange={this.handleConfigInputTyping("description")}
            value={this.props.zid_metadata.description}
            multiLine={true} />
        </div>

        <ModerateCommentsSeed params={{conversation_id: this.props.zid_metadata.conversation_id}}/>
        <ModerateCommentsSeedTweet params={{conversation_id: this.props.zid_metadata.conversation_id}}/>

        <div style={styles.configCard}>
          <p style={styles.sectionHeader}> Customize the User Interface </p>
          <div style={{marginTop: 20}}> </div>
          <Checkbox
            label="Visualization"
            disabled={!Features.canToggleVisVisibility(this.props.user)}
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
            disabled={!Features.canToggleCommentForm(this.props.user)}
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
            label="Show pol.is branding"
            ref={"branding_type"}
            disabled={!Features.canTogglePolisBranding(this.props.user)}
            checked={this.props.zid_metadata.branding_type === 1 ? true : false}
            onCheck={ this.handleIntegerBoolValueChange("branding_type").bind(this) }
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
            checked={this.props.zid_metadata.bgcolor === null ? true : false}
            onCheck={ this.handleBoolValueChange("bgcolor").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}>
              {"Unchecked: white background"}
            </p>
          <div>
            <InputField
              ref={"style_btn"}
              disabled={!Features.canCustomizeColors(this.props.user)}
              style={{width: 360}}
              onBlur={this.handleStringValueChange("style_btn").bind(this)}
              hintText="ie., #e63082"
              onChange={this.handleConfigInputTyping("style_btn")}
              value={this.props.zid_metadata.style_btn}
              floatingLabelText="Customize submit button color"
              multiLine={true} />
          </div>
          <div>
            <InputField
              ref={"help_bgcolor"}
              disabled={!Features.canCustomizeColors(this.props.user)}
              style={{width: 360}}
              onBlur={this.handleStringValueChange("help_bgcolor").bind(this)}
              onChange={this.handleConfigInputTyping("help_bgcolor")}
              value={this.props.zid_metadata.help_bgcolor}
              hintText="ie., #e63082"
              floatingLabelText="Customize help text background"
              multiLine={true} />
          </div>
          <div>
            <InputField
              ref={"help_color"}
              disabled={!Features.canCustomizeColors(this.props.user)}
              style={{width: 360}}
              onBlur={this.handleStringValueChange("help_color").bind(this)}
              onChange={this.handleConfigInputTyping("help_color")}
              value={this.props.zid_metadata.help_color}
              hintText="ie., #e63082"
              floatingLabelText="Customize help text color"
              multiLine={true} />
          </div>
        </div>
        <div style={styles.configCard}>
          <p style={styles.sectionHeader}> Schemes </p>
          <div style={{marginTop: 20}}> </div>
          <Checkbox
            label="Strict Moderation"
            ref={"strict_moderation"}
            disabled={!Features.canToggleStrictMod(this.props.user)}
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
            label="Open Data"
            ref={"is_data_open"}
            checked={this.props.zid_metadata.is_data_open}
            onCheck={ this.handleBoolValueChange("is_data_open").bind(this) }
            labelPosition={"left"}
            labelWrapperColor={settings.darkerGray}
            color={settings.polisBlue}/>
            <p style={{fontSize: 10, fontStyle: "italic"}}> Comments, votes, and group data can be exported by any user </p>
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
