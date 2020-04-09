// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import {
  changeParticipantStatusToHidden,
  changeParticipantStatusToFeatured
} from '../../actions';
import Radium from "radium";
import _ from "lodash";
import Flex from '../framework/flex';
import Participant from "./participant";
import Spinner from "../framework/spinner";

const styles = {
  card: {
    margin: 20,
    backgroundColor: "rgb(253,253,253)",
    borderRadius: 3,
    padding: 10,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
  body: {
    fontWeight: 300,
  }
}

@connect(state => state.mod_ptpt_default)
@Radium
class ParticipantModerationDefault extends React.Component {
  onFeatureClicked(participant) {
    this.props.dispatch(changeParticipantStatusToFeatured(participant))
  }
  onHideClicked(participant) {
    this.props.dispatch(changeParticipantStatusToHidden(participant))
  }
  createParticipantMarkup() {
    return _.sortByOrder(this.props.default_participants, (p) => {
      return p.twitter ? p.twitter.followers_count : 0;
    }, ["desc"]).map((p, i) => {
      let name = "[MISSING NAME]";
      if (p.xInfo) {
        name = p.xInfo.x_name;
      } else if (p.twitter) {
        name = p.twitter.name;
      } else if (p.facebook) {
        name = p.facebook.fb_name;
      }
      return (
        <Participant
          participant={p}
          featureButton
          hideButton
          featureClickHandler={this.onFeatureClicked.bind(this)}
          hideClickHandler={this.onHideClicked.bind(this)}
          name={name}
          key={i}/>
      );
    });
  }
  renderSpinner() {
    return (
      <Flex>
        <Spinner/>
        <span style={{
            marginLeft: 10,
            position: "relative",
            top: -2
          }}> Loading participants... </span>
      </Flex>
    )
  }
  render() {
    return (
      <div>
        <div style={styles.card}>
          <p style={styles.body}>
            We automatically decide who to show in the visualization, but you can override that here. The visualization will differ per user based on whether they have Facebook friends participating. Here’s how we prioritize who gets shown on a per user basis:
          </p>
          <ul style={styles.body}>
            <li> {"Each participant's Facebook friends"} </li>
            <li> {"Participants with verified Twitter accounts"} </li>
            <li> {"Participants with highest number of Twitter followers"} </li>
            <li> {"Random participants with Facebook connected"} </li>
          </ul>
          <p style={styles.body}> Featured participants are always shown. Hidden participants are only shown to Facebook friends. </p>
        </div>
        <div>
          {
            this.props.default_participants !== null ? this.createParticipantMarkup() : this.renderSpinner()
          }
        </div>
      </div>
    );
  }
}

export default ParticipantModerationDefault;
