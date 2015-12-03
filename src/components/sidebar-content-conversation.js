import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Awesome from "react-fontawesome";
import {Link} from "react-router";
import MaterialTitlePanel from './material-title-panel';

const styles = {
  sidebar: {
    width: 256,
    height: '100%',
  },
  sidebarLink: {
    display: 'block',
    padding: '16px 0px',
    color: '#757575',
    textDecoration: 'none',
  },
  divider: {
    margin: '8px 0',
    height: 1,
    backgroundColor: '#757575',
  },
  content: {
    padding: '16px',
    height: '100%',
    backgroundColor: 'white',
  },
};

@Radium
class SidebarContentConversation extends React.Component {
  render() {
    return (
      <MaterialTitlePanel
        title={"Pol.is/"+this.props.conversation_id}
        style={this.props.style ? {...styles.sidebar, ...this.props.style} : styles.sidebar}>
        <div style={styles.content}>
          <Link
            style={styles.sidebarLink}
            to={"/m/"+this.props.conversation_id+"/share"}>
            Share & Embed
          </Link>
          <Link
            style={styles.sidebarLink}
            to={"/m/"+this.props.conversation_id+"/stats"}>
            Stats
          </Link>
          <Link
            style={styles.sidebarLink}
            to={"/m/"+this.props.conversation_id+"/config"}>
            Config
          </Link>
          <Link
            style={styles.sidebarLink}
            to={"/m/"+this.props.conversation_id+"/comments"}>
            Comments
          </Link>
          <Link
            style={styles.sidebarLink}
            to={"/m/"+this.props.conversation_id+"/participants"}>
            Participants
          </Link>
          <Link
            style={styles.sidebarLink}
            to={"/m/"+this.props.conversation_id+"/conversation"}>
            iFrame of Conversation</Link>
          <Link
            style={styles.sidebarLink}
            to={"/m/"+this.props.conversation_id+"/export"}>
            Data Export
          </Link>
          <div style={styles.divider} />
          <p><a style={{marginRight: 15}} href="http://docs.pol.is">Docs</a></p>
          <p><a style={{marginRight: 15}} href="https://twitter.com/UsePolis">Follow @UsePolis</a></p>
        </div>
      </MaterialTitlePanel>
    );
  }
}

export default SidebarContentConversation;

// <p>
//   <Link to="/">
//     <Awesome name="chevron-left" style={{fontSize: 24, cursor: "pointer"}}/>
//     <Awesome name="home" style={{fontSize: 24, cursor: "pointer"}}/>
//   </Link>
// </p>
// <h3 style={{marginRight: 10}}>
//   Conversation Admin
// </h3>
// <a
//   href={"https://pol.is/"+this.props.conversation_id}
//   target="_blank">
//   {"pol.is/"+this.props.conversation_id}
// </a>