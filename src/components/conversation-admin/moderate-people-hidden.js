import React from "react";
import { connect } from "react-redux";
import { changeParticipantStatusToFeatured } from '../../actions'
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
      <div style={styles.card}>
        <div>
          <p> These participants are not shown in the visualization, but their votes are still counted. Note that they will still be shown to other participants who are their Facebook friends.</p>
        </div>
        {
          this.props.hidden_participants !== null ? this.createParticipantMarkup() : <Spinner/>
        }
      </div>
    );
  }
}

export default ParticipantModerationHidden;
