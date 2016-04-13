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
    // const comments = this.props.comments.comments;
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
