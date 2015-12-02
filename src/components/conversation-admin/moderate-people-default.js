import React from "react";
import { connect } from "react-redux";
import { populateDefaultParticipantStore } from '../../actions'
import Radium from "radium";
import _ from "lodash";

@connect(state => state.mod_ptpt_default)
@Radium
class ParticipantModerationDefault extends React.Component {
  loadDefaultParticipants() {
    this.props.dispatch(
      populateDefaultParticipantStore(this.props.params.conversation)
    )
  }
  componentWillMount () {
    this.loadDefaultParticipants()
  }
  createParticipantMarkup() {
    const participants = this.props.default_participants.map((participant, i)=>{
      return (
        <p key={i}>
         {participant.facebook ? participant.facebook.fb_name : participant.twitter.name}
        </p>
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