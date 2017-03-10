// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import _ from "lodash";
import ComponentHelpers from "../../util/component-helpers";
import Flex from "../framework/flex";
import NavTab from "../framework/nav-tab";
import NoPermission from "./no-permission";
import PolisNet from "../../util/net";
import Radium from "radium";
import React from "react";
import InputField from "material-ui/lib/text-field";
import Awesome from "react-fontawesome";
import Alert from 'react-s-alert';

import { connect } from "react-redux";
import { Link } from "react-router";
import { populateAllCommentStores } from "../../actions";

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
  button: {
    margin: "10px 20px 10px 10px",
    backgroundColor: "#54A357",
    color: "white",
    display: "inline-block",
    textAlign: "center",
    padding: "10px 20px",
    cursor: "pointer",
    border: 0,
    borderRadius: 3,
  },
  notification: {
    fontSize: 16,
    fontWeight: 500,
    color: "rgb(160,160,160)"
  }
}

@Radium
class ReportConfig extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      loading: true,
      error: false,
      report: null,
    };
  }

  getData() {
    let reportsPromise = PolisNet.polisGet("/api/v3/reports", {
      report_id: this.props.params.report_id,
    });
    reportsPromise.then((reports) => {
      this.setState({
        loading: false,
        report: reports[0],
      });
    });
  }

  componentWillMount() {
    this.getData();
  }

  updateReport () {
    let data = {
      report_id: this.props.params.report_id,
      conversation_id: this.props.params.conversation_id,
    };

    data.report_name = this.state.report.report_name;
    data.label_x_neg = this.state.report.label_x_neg;
    data.label_x_pos = this.state.report.label_x_pos;
    data.label_y_neg = this.state.report.label_y_neg;
    data.label_y_pos = this.state.report.label_y_pos;
    for (let i = 0; i < 10; i++) {
      let s = 'label_group_' + i;
      if (this.state.report[s]) {
        data[s] = this.state.report[s];
      }
    }

    return $.ajax({
      url: "/api/v3/reports",
      method: "PUT",
      contentType: "application/json; charset=utf-8",
      headers: { "Cache-Control": "max-age=0" },
      xhrFields: { withCredentials: true },
      dataType: "json",
      data: JSON.stringify(data),
    }).fail((err) => {
      alert("error " + err);
    });
  }

  // handleIntegerBoolValueChange (field) {
  //   return () => {
  //     this.props.dispatch(
  //       handleZidMetadataUpdate(
  //         this.props.zid_metadata,
  //         field,
  //         this.transformBoolToInt(this.refs[field].isChecked())
  //       )
  //     )
  //   }
  // }

  handleConfigInputTyping (field) {
    return (e) => {
      this.setState({
        report: Object.assign({}, this.state.report, { [field]: e.target.value }),
      });
    }
  }

  createMarkup() {
    return (
      <div>
          <Alert />
          <button style={styles.button} onClick={() => {
            this.setState({error: !this.state.error})
            Alert.error('Error saving. Check your internet connection and try again.', {
              position: 'top-right',
              beep: true,
              timeout: 5000,
              offset: 80
            });
          }}>
          <Awesome name="floppy-o"/>
          <span style={{marginLeft: 10}}>{"Save"}</span>
        </button>
        <p>{"" + this.state.error}</p>
        {/* error and loading may go here - see conversation-config.js */}
        <div style={styles.configCard}>
          <p style={styles.sectionHeader}>Report {this.props.params.report_id}</p>
          <InputField
            ref={"report_name"}
            style={{width: 360}}
            onChange={this.handleConfigInputTyping("report_name").bind(this)}
            value={this.state.report["report_name"]}
            hintText="ie., 'Monthly check-in (August)'"
            floatingLabelText={"Report name"}
            multiLine={true} />
            <p style={{fontSize: 10, fontStyle: "italic"}}> </p>
        </div>

        <div style={styles.configCard}>
          <p style={styles.sectionHeader}> Create axis labels </p>
          <div>
            <InputField
              ref={"label_x_neg"}
              style={{width: 360}}
              onChange={this.handleConfigInputTyping("label_x_neg").bind(this)}
              value={this.state.report["label_x_neg"]}
              hintText="ie., 'In favor of more regulation'"
              floatingLabelText={"Label for negative x axis (←)"}
              multiLine={true} />
            <InputField
              ref={"label_x_pos"}
              style={{width: 360}}
              onChange={this.handleConfigInputTyping("label_x_pos").bind(this)}
              value={this.state.report["label_x_pos"]}
              hintText="ie., 'Opposed to more regulation'"
              floatingLabelText={"Label for positive x axis (→)"}
              multiLine={true} />
            <InputField
              ref={"label_y_neg"}
              style={{width: 360}}
              onChange={this.handleConfigInputTyping("label_y_neg").bind(this)}
              value={this.state.report["label_y_neg"]}
              hintText="ie., 'Individuals are responsible'"
              floatingLabelText={"Label for negative y axis (↓)"}
              multiLine={true} />
            <InputField
              ref={"label_y_pos"}
              style={{width: 360}}
              onChange={this.handleConfigInputTyping("label_y_pos").bind(this)}
              value={this.state.report["label_y_pos"]}
              hintText="ie., 'Society is responsible'"
              floatingLabelText={"Label for positive y axis (↑)"}
              multiLine={true} />
          </div>
        </div>
        <div style={styles.configCard}>
          <p style={styles.sectionHeader}> Create group nicknames </p>
          <div>
            {
              /* we have 10 groups max hardcoded for now */
              [0,1,2,3,4,5,6,7,8,9].map((d, i) => {
                // if (!this.state.report["label_group_" + i]) {return}
                let userVisibleGroupId = i+1;
                return (
                  <InputField
                    ref={"label_group_" + i}
                    style={{width: 360}}
                    onChange={this.handleConfigInputTyping("label_group_" + i).bind(this)}
                    value={this.state.report["label_group_" + i]}
                    hintText="ie., 'Dog lovers'"
                    floatingLabelText={"Group "+ userVisibleGroupId +" nickname"}
                    multiLine={true} />
                )
              })
            }
          </div>
        </div>
      {/* container */} </div>
    )
  }

  render() {
    return (
      <div style={styles.container}>
        {this.state.report ? this.createMarkup() : "Loading"}
      </div>
    );
  }
}

export default ReportConfig;

// {
//   "report_id":"r6ehukhk29tcfmuc57vrj",
//   "created":"1488835750478",
//   "modified":"1488925945969",
//   "label_x_neg":"label_x_neg",
//   "label_y_neg":"label_y_neg",
//   "label_y_pos":"label_y_pos",
//   "label_x_pos":"label_x_pos",
//   "label_group_0":"label_group_0",
//   "label_group_1":"label_group_1",
//   "label_group_2":"label_group_2",
//   "label_group_3":"label_group_3",
//   "label_group_4":null,
//   "label_group_5":null,
//   "label_group_6":null,
//   "label_group_7":null,
//   "label_group_8":null,
//   "label_group_9":null,
//   "conversation_id":"36jajfnhhn"
// }
