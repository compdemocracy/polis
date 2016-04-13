import React from "react";
import Radium from "radium";
// import _ from "lodash";
// import Flex from "./framework/flex";
import { connect } from "react-redux";
// import { FOO } from "../actions";
// import { VictoryBar } from "victory";

@connect((state) => {
  return {
    comments: state.comments,
    math: state.math,
  };
})
@Radium
class SummaryBarchart extends React.Component {
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
    math: React.PropTypes.object,
    comments: React.PropTypes.object
    // foo: React.PropTypes.string
  }
  static defaultProps = {
    // foo: "bar"
  }
  getStyles() {
    return {
      base: {

      }
    };
  }
  barchart() {
    const math = this.props.math.math;
    const comments = this.props.comments.comments;

    return _.map(math["group-votes"], (votes, i) => {
      console.log(votes)
      return (
        <div>
          <p>
            <span style={{
              backgroundColor: "rgb(240,240,240)",
              padding: "3px 6px",
              borderRadius: 3,
              color: "rgb(170,170,170)",
              fontWeight: 300
            }}> Group {++i}:</span>
            <span style={{fontWeight: 300}}>
              {` ${votes.votes[this.props.tid].A} agreed & `}
              {`${votes.votes[this.props.tid].D} disagreed`}
            </span>
          </p>
        </div>
      )
    })
  }
  render() {
    const math = this.props.math.math;
    const styles = this.getStyles();
    return (
      <div style={[
        styles.base,
        this.props.style
      ]}>
        {
          math && !this.props.math.loading && !this.props.comments.loading ?
            this.barchart() :
            ""
        }
      </div>
    );
  }
}

export default SummaryBarchart;

//
// <VictoryBar horizontal stacked
//   height={80}
//   padding={30}
//   style={{
//     data: {width: 3},
//     labels: {fontSize: 12}
//   }}
//   data={[
//     [
//       {x: 1, y: 1},
//       {x: 2, y: 2},
//       {x: 3, y: 3}
//     ],
//     [
//       {x: 1, y: 2},
//       {x: 2, y: 1},
//       {x: 3, y: 1}
//     ],
//     [
//       {x: 1, y: 3},
//       {x: 2, y: 4},
//       {x: 3, y: 2}
//     ],
//   ]}
//   labels={["one", "two", "three"]}
//   dataAttributes={[
//     {fill: "rgb(231, 76, 60)"},
//     {fill: "rgb(46, 204, 113)"},
//     {fill: "rgb(200,200,200)"},
//   ]}
//   />
