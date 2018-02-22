// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import _ from "lodash";
// import Flex from "./framework/flex";
// import { connect } from "react-redux";
// import { FOO } from "../actions";
import Group from "./summary-group";

// @connect(state => {
//   return state.FOO;
// })
@Radium
class SummaryGroups extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
    };
  }
  static propTypes = {
    /* react */
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
    /* component api */
    style: React.PropTypes.object,
  }

  getStyles() {
    return {
      base: {

      },
      sectionHeader: {
        fontWeight: 500,
        fontSize: 24
      },
      text: {
        fontWeight: 300,
        maxWidth: 600
      },
      mostAgreedUpon: {
        backgroundColor: "rgb(46, 204, 113)"
      },
    };
  }
  groups() {
    const math = this.props.math.math;
    return _.map(math["repness"], (comments, i) => {
      return (
        <Group
          key={i}
          repnessIndex={i}
          groupComments={comments}
          {...this.props}/>
      );
    });
  }
  render() {
    const styles = this.getStyles();
    const comments = this.props.comments.comments;
    const math = this.props.math.math;
    return (
      <span>
        <p style={styles.sectionHeader}> Opinion Groups </p>
        {this.groups()}
      </span>
    );
  }
}

export default SummaryGroups;
