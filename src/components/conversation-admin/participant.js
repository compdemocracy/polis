import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Flex from "../framework/flex";
import Awesome from "react-fontawesome";
import Button from "../framework/generic-button";

const cardHeight = 50;
const cardPadding = 10;
const cardBorderRadius = 3;

const styles = {
  card: {
    height: cardHeight,
    margin: "10px 20px 10px 20px",
    backgroundColor: "rgb(253,253,253)",
    borderRadius: cardBorderRadius,
    padding: cardPadding,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
}

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
      <Button
        onClick={this.onFeatureClicked.bind(this)}>
        <Awesome name="chevron-up"/> feature
      </Button>
    )
  }
  makeHideButton() {
    return (
      <Button
        onClick={this.onHideClicked.bind(this)}>
        <Awesome name="ban"/> hide
      </Button>
    )
  }
  render() {
    return (
      <Flex
        justifyContent={"space-between"}
        styleOverrides={styles.card}>
        <Flex.Item
          small={2}>
          <span>{this.props.name}</span>
        </Flex.Item>
        <Flex>
          {this.props.featureButton ? this.makeFeatureButton() : ""}
          {this.props.hideButton ? this.makeHideButton() : ""}
        </Flex>
      </Flex>
    );
  }
}

/*
  Todo
    per participant stats - how much they voted, how many connections, verified,
    sorting - by followers etc
*/

export default Participant;