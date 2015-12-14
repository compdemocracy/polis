import React from "react";
import { connect } from "react-redux";
import { changeParticipantStatusToFeatured } from '../../actions'
import Radium from "radium";
import _ from "lodash";
import Participant from "./participant";

@connect(state => state.mod_ptpt_hidden)
@Radium
class ParticipantModerationHidden extends React.Component {
  onFeatureClicked(participant) {
    this.props.dispatch(changeParticipantStatusToFeatured(participant))
  }
  createParticipantMarkup() {
    const participants = this.props.hidden_participants.map((participant, i)=>{
      return (
        <Participant
          participant={participant}
          featureButton
          featureClickHandler={this.onFeatureClicked.bind(this)}
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
        <h1>ParticipantModerationHidden</h1>
        <div>
          <p> These participants are not shown in the visualization, but their votes are still counted. Note that they will still be shown to other participants who are their Facebook friends.</p>
        </div>
        {
          this.props.hidden_participants !== null ? this.createParticipantMarkup() : "spinnrrrr"
        }
      </div>
    );
  }
}

export default ParticipantModerationHidden;
