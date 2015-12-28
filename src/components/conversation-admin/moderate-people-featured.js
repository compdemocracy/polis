import React from "react";
import { connect } from "react-redux";
import { changeParticipantStatusToHidden } from '../../actions'
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

@connect(state => state.mod_ptpt_featured)
@Radium
class ParticipantModerationFeatured extends React.Component {
  onHideClicked(participant) {
    this.props.dispatch(changeParticipantStatusToHidden(participant))
  }
  createParticipantMarkup() {
    const participants = this.props.featured_participants.map((participant, i)=>{
      return (
        <Participant
          participant={participant}
          hideButton
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
          <p> Those featured participants with more followers will be prioritized if there are too many featured participants to show in the visualization. </p>
        </div>
        <div>
          {
            this.props.featured_participants !== null ? this.createParticipantMarkup() : <Spinner/>
          }
        </div>
      </div>
    );
  }
}

export default ParticipantModerationFeatured;
