import React from "react";
import { connect } from "react-redux";

@connect(state => state.data)
class App extends React.Component {
  render() {
    return (
      <h1>{this.props.message}</h1>
    );
  }
}

export default App;