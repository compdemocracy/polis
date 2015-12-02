import React from "react";
import { connect } from "react-redux";
import { populateFeaturedParticipantStore } from '../../actions'
import Radium from "radium";
import _ from "lodash";

@connect(state => state.mod_ptpt_featured)
@Radium
class ParticipantModerationFeatured extends React.Component {
  loadFeaturedParticipants() {
    this.props.dispatch(
      populateFeaturedParticipantStore(this.props.params.conversation)
    )
  }

  componentWillMount () {
    this.loadFeaturedParticipants()
  }
  createParticipantMarkup() {
    const participants = this.props.featured_participants.map((participant, i)=>{
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
        <h1>ParticipantModerationFeatured</h1>
        <p> Featured participants are always shown in the visualization. If their Twitter accounts are connected, they will be shown to other participants. Those with more followers will be prioritized if there are too many featured participants to show. </p>
        <div>
          {
            this.props.featured_participants !== null ? this.createParticipantMarkup() : "spinnrrrr"
          }
        </div>
      </div>
    );
  }
}

export default ParticipantModerationFeatured;