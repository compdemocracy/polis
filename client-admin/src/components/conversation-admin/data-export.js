// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import { startDataExport } from "../../actions";
import _ from "lodash";
import RadioButton from "material-ui/RadioButton";
import RadioButtonGroup from "material-ui/RadioButton/RadioButtonGroup";
import SelectField from "material-ui/SelectField";
import Button from "../framework/generic-button";
import dateSetupUtil from "../../util/data-export-date-setup";
import Flex from "../framework/flex";
import Awesome from "react-fontawesome";
import Checkbox from "material-ui/Checkbox";
import settings from "../../settings";

const styles = {
  container: {
    backgroundColor: "rgb(240,240,247)",
    marginBottom: -20,
  },
  exportCard: {
    backgroundColor: "rgb(253,253,253)",
    margin: "0px 20px 20px 20px",
    borderRadius: 3,
    padding: 20,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
  },
};

@connect((state) => state.zid_metadata)
@Radium
class DataExport extends React.Component {
  constructor(props) {
    super(props);
    var times = dateSetupUtil();
    this.state = Object.assign({}, times, { showHelpMessage: false });
  }
  handleExportClicked() {
    return () => {
      this.setState({ showHelpMessage: true });

      const year = this.refs.exportSelectYear.value;
      const month = this.refs.exportSelectMonth.value;
      const dayOfMonth = this.refs.exportSelectDay.value;
      const tz = this.refs.exportSelectHour.value;
      const format = this.refs.chooseFormat.getSelectedValue();
      console.log("format", format);

      const dateString = [year, month, dayOfMonth, tz].join(" ");
      const dddate = new Date(dateString);

      this.props.dispatch(
        startDataExport(
          this.props.zid_metadata.conversation_id,
          format,
          (dddate / 1000) << 0,
          !!this.state.untilEnabled
        )
      );
    };
  }
  showHelpMessage() {
    return (
      <div style={{ marginTop: 20 }}>
        <p
          style={{
            backgroundColor: "rgb(240,240,240)",
            padding: 20,
            borderRadius: 3,
          }}
        >
          <Awesome name="cloud-download" /> Data from this conversation will be sent to your email.
          (This can take a little while, especially for larger conversations).
        </p>
      </div>
    );
  }
  handleUntilToggled() {
    this.setState({ untilEnabled: !this.state.untilEnabled });
  }
  render() {
    return (
      <div style={styles.container}>
        <div style={styles.exportCard}>
          <p style={{ marginTop: 0 }}> Until: </p>
          <input
            onClick={this.handleUntilToggled.bind(this)}
            style={{
              marginRight: 10,
            }}
            type="checkbox"
          />
          <select
            disabled={this.state.untilEnabled ? "" : "disabled"}
            style={{
              marginRight: 10,
              cursor: "pointer",
              fontSize: 16,
            }}
            ref="exportSelectYear"
          >
            {this.state.years.map((year, i) => {
              return (
                <option selected={year.selected} key={i} value={year.name}>
                  {" "}
                  {year.name}{" "}
                </option>
              );
            })}
          </select>
          <select
            disabled={this.state.untilEnabled ? "" : "disabled"}
            style={{
              marginRight: 10,
              cursor: "pointer",
              fontSize: 16,
            }}
            ref="exportSelectMonth"
          >
            {this.state.months.map((month, i) => {
              return (
                <option selected={month.selected} key={i} value={month.name}>
                  {" "}
                  {month.name}{" "}
                </option>
              );
            })}
          </select>
          <select
            disabled={this.state.untilEnabled ? "" : "disabled"}
            style={{
              marginRight: 10,
              cursor: "pointer",
              fontSize: 16,
            }}
            ref="exportSelectDay"
          >
            {this.state.days.map((day, i) => {
              return (
                <option selected={day.selected} key={i} value={day.name}>
                  {" "}
                  {day.name}{" "}
                </option>
              );
            })}
          </select>
          <select
            disabled={this.state.untilEnabled ? "" : "disabled"}
            style={{
              marginRight: 10,
              cursor: "pointer",
              fontSize: 16,
            }}
            ref="exportSelectHour"
          >
            {this.state.tzs.map((tz, i) => {
              return (
                <option selected={tz.selected} key={i} value={tz.name}>
                  {" "}
                  {tz.name}{" "}
                </option>
              );
            })}
          </select>
          <p style={{ fontWeight: 300, maxWidth: 400, lineHeight: 1.5 }}>
            {" "}
            {
              "(By default, the entire dataset is returned. To limit the last timestamp returned, enter a date here.)"
            }{" "}
          </p>
          <p> Format: </p>
          <RadioButtonGroup ref="chooseFormat" name="format" defaultSelected="csv">
            <RadioButton value="csv" label="CSV" style={{ marginBottom: 5 }} />
            <RadioButton
              disabled
              value="xls"
              label="XLS (coming soon)"
              style={{ marginBottom: 5 }}
            />
          </RadioButtonGroup>
          <Button
            style={{
              backgroundColor: "#03a9f4",
              color: "white",
              marginTop: 20,
            }}
            onClick={this.handleExportClicked().bind(this)}
          >
            Export
          </Button>
          {this.state.showHelpMessage ? this.showHelpMessage() : ""}
        </div>
      </div>
    );
  }
}

export default DataExport;

/*
  todo
    validation of dates with moment - should have the start date as well
*/
