import React from "react";
import {connect} from "react-redux";
import Radium from "radium";
import {VictoryChart} from "victory-chart";
import _ from "lodash";

@Radium
class UserStatsWidget extends React.Component {

  render() {
    function getBarData() {
    return _.map(_.range(5), () => {
      return [
        {
          x: "🍎",
          y: _.random(1, 5)
        },
        {
          x: "🍌",
          y: _.random(1, 10)
        },
        {
          x: "🍓",
          y: _.random(1, 15)
        }
      ];
    });
  }

    return (
      <VictoryChart
            data={getBarData()}
            dataAttributes={[
              {type: "stackedBar", fill: "cornflowerblue"},
              {type: "stackedBar", fill: "orange"},
              {type: "stackedBar", fill: "greenyellow"},
              {type: "stackedBar", fill: "gold"},
              {type: "stackedBar", fill: "tomato"}
            ]}
            tickValues={{x: ['🍎', '🍌', '🍓']}}
            tickFormat={{x: ['🍎', '🍌', '🍓']}}
            domainPadding={{
              x: 20,
              y: 0
            }}/>
    );
  }
}

export default UserStatsWidget;

// var styles = (i) => {
//   return {
//     backgroundColor: `rgb(${i * 50}, 50, 50)`
//   };
// };


