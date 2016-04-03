import React from "react";
import { connect } from "react-redux";
import { changeParticipantStatusToHidden } from '../../actions'
import Radium from "radium";
import _ from "lodash";
import Participant from "./participant";
import Spinner from "../framework/spinner";
import Flex from '../framework/Flex';

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

@connect(state => state.mod_ptpt_featured)
@Radium
class ParticipantModerationFeatured extends React.Component {
  onHideClicked(participant) {
    this.props.dispatch(changeParticipantStatusToHidden(participant))
  }
  createParticipantMarkup() {
    return _.sortByOrder(this.props.featured_participants, (p) => {
      console.log(p);
      return p.twitter ? p.twitter.followers_count : 0;
    }, ["desc"]).map((participant, i)=>{
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
          <p style={styles.body}> Those featured participants with more followers will be prioritized if there are too many featured participants to show in the visualization. </p>
        </div>
        <div>
          {
            this.props.featured_participants !== null ? this.createParticipantMarkup() : this.renderSpinner()
          }
        </div>
      </div>
    );
  }
}

export default ParticipantModerationFeatured;
