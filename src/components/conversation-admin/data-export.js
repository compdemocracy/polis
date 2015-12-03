import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

// @connect(state => state.data)
@Radium
class DataExport extends React.Component {
  render() {
    return (
      <div>
        <h1>DataExport</h1>
        <div>
          "DataExport"
        </div>
      </div>
    );
  }
}

export default DataExport;