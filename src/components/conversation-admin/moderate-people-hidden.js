import React from "react";
import { connect } from "react-redux";
import { populateHiddenParticipantStore } from '../../actions'
import Radium from "radium";
import _ from "lodash";

@connect(state => state.mod_ptpt_hidden)
@Radium
class ParticipantModerationHidden extends React.Component {
  // loadHiddenParticipants() {
  //   this.props.dispatch(
  //     populateHiddenParticipantStore(this.props.params.conversation)
  //   )
  // }
  // componentWillMount () {
  //   this.loadHiddenParticipants()
  // }
  createParticipantMarkup() {
    const participants = this.props.hidden_participants.map((participant, i)=>{
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
        <h1>ParticipantModerationHidden</h1>
        <div>
          {"grrr not sure why this data was showing up in featured instead of featured's spinner what the heck"}
          <p> These participants are not shown in the visualization, but their votes are still counted. Note that they will still be shown to other participants who are their Facebook friends.</p>
        </div>
      </div>
    );
  }
}

export default ParticipantModerationHidden;

          // {
          //   this.props.hidden_participants !== null ? this.createParticipantMarkup() : "spinnrrrr"
          // }