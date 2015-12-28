import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import RadioButton from "material-ui/lib/radio-button";
import RadioButtonGroup from "material-ui/lib/radio-button-group";
import SelectField from "material-ui/lib/select-field";
import moment from "moment";
import Button from "../framework/generic-button";

window.moment = moment

let years = [
  "2012",
  "2013",
  "2014",
  "2015",
  "2016"
]

let months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]

let days = []
for (var day = 1; day <= 31; day++) {
  days.push(day)
}

let hours = [
  "UTC-1200",
  "UTC-1100",
  "UTC-1000",
  "UTC-0900",
  "UTC-0800",
  "UTC-0600",
  "UTC-0500",
  "UTC-0430",
  "UTC-0400",
  "UTC-0330",
  "UTC-0300",
  "UTC-0200",
  "UTC-0100",
  "UTC+0000",
  "UTC+0100",
  "UTC+0200",
  "UTC+0300",
  "UTC+0330",
  "UTC+0400",
  "UTC+0430",
  "UTC+0500",
  "UTC+0530",
  "UTC+0600",
  "UTC+0630",
  "UTC+0700",
  "UTC+0800",
  "UTC+0830",
  "UTC+0900",
  "UTC+0930",
  "UTC+1000",
  "UTC+1030",
  "UTC+1100",
  "UTC+1200",
  "UTC+1245",
  "UTC+1300",
  "UTC+1400",
]

const styles = {
  container: {
    backgroundColor: "rgb(240,240,247)",
    paddingTop: 10,
    minHeight: "100vh"
  },
  exportCard: {
    backgroundColor: "rgb(253,253,253)",
    margin: 20,
    borderRadius: 3,
    padding: 20,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
};

@connect(state => state.zid_metadata)
@Radium
class DataExport extends React.Component {
  render() {
    window.md = this.props.zid_metadata.created
    const created = moment(this.props.zid_metadata.created);
    const elapsed = moment(created).toNow()
    const time = created.year()

    return (
      <div style={styles.container}>
        <div style={styles.exportCard}>
          <p> This conversation was created  </p>
          <p> Until: </p>
          <select id="exportSelectYear">
            {
              years.map((year, i)=>{
                return (
                  <option key={i} value={year}> {year} </option>
                )
              })
            }
          </select>
          <select id="exportSelectYear">
            {
              months.map((month, i)=>{
                return (
                  <option key={i} value={month}> {month} </option>
                )
              })
            }
          </select>
          <select id="exportSelectYear">
            {
              days.map((day, i)=>{
                return (
                  <option key={i} value={day}> {day} </option>
                )
              })
            }
          </select>
          <select id="exportSelectYear">
            {
              hours.map((hours, i)=>{
                return (
                  <option key={i} value={hours}> {hours} </option>
                )
              })
            }
          </select>
          <p> Format: </p>
          <RadioButtonGroup name="format" defaultSelected="csv">
            <RadioButton
              value="csv"
              label="CSV"
              style={{marginBottom:5}} />
            <RadioButton
              value="xls"
              label="XLS (Excel)"
              style={{marginBottom:5}}/>
          </RadioButtonGroup>
          <Button
            onClick={() => { console.log("todo: export action goes here") }}
            style={{
              marginTop: 20
            }}>
            Export
          </Button>
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

