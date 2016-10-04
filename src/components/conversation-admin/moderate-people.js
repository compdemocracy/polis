import _ from "lodash";
import ComponentHelpers from "../../util/component-helpers";
import Flex from "../framework/flex";
import NavTab from "../framework/nav-tab";
import NoPermission from "./no-permission";
import Radium from "radium";
import React from "react";
import { connect } from "react-redux";
import { Link } from "react-router";
import { populateAllParticipantStores } from "../../actions";

const cardPadding = 10;
const cardBorderRadius = 3;

const styles = {
  container: {
    backgroundColor: "rgb(240,240,247)",
    paddingTop: 10,
    minHeight: "100vh"
  },
  navCard: {
    margin: 20,
    backgroundColor: "rgb(253,253,253)",
    borderRadius: cardBorderRadius,
    padding: cardPadding,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
};

const mapStateToProps = (state) => {
  return {
    ptpt_default: state.mod_ptpt_default,
    ptpt_featured: state.mod_ptpt_featured,
    ptpt_hidden: state.mod_ptpt_hidden
  };
};

const pollFrequency = 7000;

@connect(state => state.zid_metadata)
@connect(mapStateToProps)
@Radium
class ModeratePeople extends React.Component {
  getStyles() {
    return {
      navContainer: {
        margin: "10px 20px 20px 20px",
      }
    };
  }
  loadParticipants() {
    this.props.dispatch(
      populateAllParticipantStores(this.props.params.conversation_id)
    )
  }
  componentWillMount() {
    this.getParticipantsRepeatedly = setInterval(() => {
      this.loadParticipants();
    }, pollFrequency);
  }
  componentDidMount() {
    this.loadParticipants();
  }
  componentWillUnmount() {
    clearInterval(this.getParticipantsRepeatedly);
  }
  render() {
    if (ComponentHelpers.shouldShowPermissionsError(this.props)) {
      return <NoPermission/>
    }
    const styles = this.getStyles();
    const m = "/m/"+this.props.params.conversation_id+"/participants/";
    return (
      <div>
        <Flex
          wrap="wrap"
          justifyContent="flex-start"
          styleOverrides={styles.navContainer}>
          <NavTab
            active={this.props.routes[3].path ? false : true}
            url={`/m/${this.props.params.conversation_id}/participants/`}
            text="Default"
            number={
              this.props.ptpt_default.default_participants ?
                this.props.ptpt_default.default_participants.length :
                "..."
            }/>
          <NavTab
            active={this.props.routes[3].path === "featured"}
            url={`/m/${this.props.params.conversation_id}/participants/featured`}
            text="Featured"
            number={
              this.props.ptpt_featured.featured_participants ?
                this.props.ptpt_featured.featured_participants.length :
                "..."
            }/>
          <NavTab
            active={this.props.routes[3].path === "hidden"}
            url={`/m/${this.props.params.conversation_id}/participants/hidden`}
            text="Hidden"
            number={
              this.props.ptpt_hidden.hidden_participants ?
                this.props.ptpt_hidden.hidden_participants.length :
                "..."
            }/>
        </Flex>
        {this.props.children}
      </div>
    );
  }
}

export default ModeratePeople;
