import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import { populateAllParticipantStores } from "../../actions";
import _ from "lodash";
import { Link } from "react-router";

const mapStateToProps = (state, ownProps) => {
  return {
    ptpt_default: state.mod_ptpt_default,
    ptpt_featured: state.mod_ptpt_featured,
    ptpt_hidden: state.mod_ptpt_hidden
  }
}

@connect(mapStateToProps)
@Radium
class ModeratePeople extends React.Component {
  loadParticipants() {
    this.props.dispatch(
      populateAllParticipantStores(this.props.params.conversation_id)
    )
  }
  componentWillMount () {
    this.getParticipantsRepeatedly = setInterval(()=>{
      this.loadParticipants()
    },2000);
  }
  componentWillUnmount() {
    clearInterval(this.getParticipantsRepeatedly);
  }
  render() {
    const m = "/m/"+this.props.params.conversation_id+"/participants/";
    return (
      <div>
        <h1>Moderate Participants</h1>
        <div>
          "Moderate Participants"
          <p>
            We automatically decide who to show in the visualization, but you can override that here. The visualization will differ per user based on whether they have Facebook friends participating. Here’s how we prioritize who gets shown:
          </p>
          <ul>
            <li> Facebook friends </li>
            <li> Participants with verified Twitter accounts </li>
            <li> Participants with highest number of Twitter followers </li>
            <li> Participants with Facebook connected </li>
          </ul>
          <p> Featured participants are always shown. Hidden participants are only shown to Facebook friends. </p>
        </div>
          <Link
            style={{
              marginLeft: -10,
              padding: 10,
              borderRadius: 3,
              cursor: "pointer",
              textDecoration: "none",
              fontWeight: 700
            }}
            to={m}>
            {"Default "}
            {
              this.props.ptpt_default.default_participants ?
              this.props.ptpt_default.default_participants.length :
              "..."
            }
          </Link>
          <Link
            style={{
              padding: 10,
              borderRadius: 3,
              cursor: "pointer",
              textDecoration: "none",
              fontWeight: 700
            }}
            to={m + "featured"}>
            {"Featured "}
            {
              this.props.ptpt_featured.featured_participants ?
              this.props.ptpt_featured.featured_participants.length :
              "..."
            }
          </Link>
          <Link
            style={{
              padding: 10,
              borderRadius: 3,
              cursor: "pointer",
              textDecoration: "none",
              fontWeight: 700
            }}
            to={m + "hidden"}>
            {"Hidden "}
            {
              this.props.ptpt_hidden.hidden_participants ?
              this.props.ptpt_hidden.hidden_participants.length :
              "..."
            }
          </Link>
        {this.props.children}
      </div>
    );
  }
}

var styles = {
  backgroundColor: `hsla(${Math.random() * 255}, 50%, 50%, ${Math.random()})`,
  padding: '5px',
  color: 'white',
  border: 0,
  ':hover': {
    backgroundColor: 'blue'
  }
};

export default ModeratePeople;
