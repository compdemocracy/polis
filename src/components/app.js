import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

import UserStatsWidget from "./user-stats-widget";

@connect(state => state.data)
@Radium
class App extends React.Component {

  getStats() {
    return _.map(_.range(5), i => <UserStatsWidget key={i} />);
  }

  render() {
    return (
      <div>
        <h1>{this.props.message}</h1>
        <button style={styles}>Click Me</button>
        <div>
          {this.getStats()}
        </div>
      </div>
    );
  }
}

var styles = {
  backgroundColor: `hsla(${Math.random() * 255}, 50%, 50%, ${Math.random()})`,
  padding: '5px',
  color: 'white',
  border: 0,
  ':hover': {
    backgroundColor: 'blue'
  }
};

export default App;
