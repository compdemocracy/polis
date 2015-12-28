import React from "react";
import { connect } from "react-redux";
import {
  changeParticipantStatusToHidden,
  changeParticipantStatusToFeatured
} from '../../actions';
import Radium from "radium";
import _ from "lodash";
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
    const participants = this.props.default_participants.map((participant, i)=>{
      return (
        <Participant
          participant={participant}
          featureButton
          hideButton
          featureClickHandler={this.onFeatureClicked.bind(this)}
          hideClickHandler={this.onHideClicked.bind(this)}
          name={
            participant.facebook ?
            participant.facebook.fb_name :
            participant.twitter.name
          }
          key={i}/>
      )
    })
    return participants;
  }
  render() {
    return (
      <div>
        <div style={styles.card}>
          <p>
            We automatically decide who to show in the visualization, but you can override that here. The visualization will differ per user based on whether they have Facebook friends participating. Here’s how we prioritize who gets shown on a per user basis:
          </p>
          <ul>
            <li> {"Each participant's Facebook friends"} </li>
            <li> {"Participants with verified Twitter accounts"} </li>
            <li> {"Participants with highest number of Twitter followers"} </li>
            <li> {"Random participants with Facebook connected"} </li>
          </ul>
          <p> Featured participants are always shown. Hidden participants are only shown to Facebook friends. </p>
        </div>
        <div>
          {
            this.props.default_participants !== null ? this.createParticipantMarkup() : <Spinner/>
          }
        </div>
      </div>
    );
  }
}

export default ParticipantModerationDefault;
