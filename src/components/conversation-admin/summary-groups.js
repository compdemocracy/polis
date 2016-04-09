import React from "react";
import Radium from "radium";
// import _ from "lodash";
// import Flex from "./framework/flex";
// import { connect } from "react-redux";
// import { FOO } from "../actions";


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
    // dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
    /* component api */
    style: React.PropTypes.object,
    // foo: React.PropTypes.string
  }
  static defaultProps = {
    // foo: "bar"
  }
  getStyles() {
    return {
      base: {

      },
      sectionHeader: {
        fontWeight: 100,
        textTransform: "uppercase",
        fontSize: 16
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
  getGroupComments() {
    // const comments = this.props.comments.comments;
    const math = this.props.math.math;
    return math["group-clusters"].map((group, i) => {
      return (
        <p> Group {i} </p>
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
        <p> There were {math["group-clusters"].length} groups. The largest had x, etc </p>
        {this.getGroupComments()}
      </span>
    );
  }
}

export default SummaryGroups;
