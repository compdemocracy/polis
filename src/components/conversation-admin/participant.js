import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

// @connect(state => state.data)
@Radium
class Participant extends React.Component {
  onFeatureClicked() {
    this.props.featureClickHandler(this.props.participant)
  }
  onHideClicked() {
    this.props.hideClickHandler(this.props.participant)
  }
  makeFeatureButton() {
    return (
      <button onClick={this.onFeatureClicked.bind(this)}> feature </button>
    )
  }
  makeHideButton() {
    return (
      <button onClick={this.onHideClicked.bind(this)}> hide </button>
    )
  }
  render() {
    return (
      <div>
        <p>
          {this.props.name}
          {this.props.featureButton ? this.makeFeatureButton() : ""}
          {this.props.hideButton ? this.makeHideButton() : ""}
        </p>
      </div>
    );
  }
}

export default Participant;