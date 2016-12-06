// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
// import _ from "lodash";
import Flex from "../framework/flex";
import Awesome from "react-fontawesome";
import Button from "../framework/generic-button";
import ParticipantHeader from "./participant-header";


const styles = {
  card: {
    margin: "10px 20px 10px 20px",
    backgroundColor: "rgb(253,253,253)",
    borderRadius: 3,
    padding: 10,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
  buttons: {
    marginTop: 20
  }
};

@Radium
class Participant extends React.Component {
  static propTypes = {
    /* react */
    // dispatch: React.PropTypes.func,
    params: React.PropTypes.object
    /* component api */
    // foo: React.PropTypes.string
  }
  static defaultProps = {
    // foo: "bar"
  }
  onFeatureClicked() {
    this.props.featureClickHandler(this.props.participant)
  }
  onHideClicked() {
    this.props.hideClickHandler(this.props.participant)
  }
  makeFeatureButton() {
    return (
      <Button
        style={{
          backgroundColor: "#03a9f4",
          color: "white",
          marginRight: 20
        }}
        onClick={this.onFeatureClicked.bind(this)}>
        <Awesome name="chevron-up"/> feature
      </Button>
    )
  }
  makeHideButton() {
    return (
      <Button
        style={{
          backgroundColor: "#03a9f4",
          color: "white",
        }}
        onClick={this.onHideClicked.bind(this)}>
        <Awesome name="ban"/> hide
      </Button>
    )
  }
  render() {
    return (
      <div style={styles.card}>
        <Flex
          direction="column"
          wrap="wrap"
          justifyContent="space-between"
          alignItems={"baseline"}>
          <ParticipantHeader
            {...this.props.participant.facebook}
            {...this.props.participant.twitter} />
          <Flex styleOverrides={styles.buttons}>
            {this.props.featureButton ? this.makeFeatureButton() : ""}
            {this.props.hideButton ? this.makeHideButton() : ""}
          </Flex>
        </Flex>
      </div>
    );
  }
}

/*
  Todo
    per participant stats - how much they voted, how many connections, verified,
    sorting - by followers etc
*/

export default Participant;
