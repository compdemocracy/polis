import React from "react";
import { connect } from "react-redux";
import {
  changeParticipantStatusToHidden,
  changeParticipantStatusToFeatured
} from '../../actions';
import Radium from "radium";
import _ from "lodash";
import Participant from "./participant";

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
        <h1>ParticipantModerationDefault</h1>
        <div>
          {
            this.props.default_participants !== null ? this.createParticipantMarkup() : "spinnrrrr"
          }
        </div>
      </div>
    );
  }
}

export default ParticipantModerationDefault;
