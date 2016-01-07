import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Awesome from "react-fontawesome";
import {Link} from "react-router";
import MaterialTitlePanel from './material-title-panel-sidebar';

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
    backgroundColor: 'white',
  },
};

@Radium
class SidebarContentConversation extends React.Component {
  render() {
    return (
      <MaterialTitlePanel
        showHamburger={false}
        title={"Pol.is/"+this.props.conversation_id}
        style={this.props.style ? {...styles.sidebar, ...this.props.style} : styles.sidebar}>
        <div style={styles.content}>
          <Link
            style={styles.sidebarLink}
            to={"/"}>
            <Awesome name="chevron-left"/>
            <span style={{marginLeft: 15}}> Back </span>
          </Link>
          <Link
            style={styles.sidebarLink}
            to={"/m/"+this.props.conversation_id}>
            <Awesome name="gears"/>
            <span style={{marginLeft: 10}}> Config </span>
          </Link>
          <Link
            style={styles.sidebarLink}
            to={"/m/"+this.props.conversation_id+"/share"}>
            <Awesome name="code"/>
            <span style={{marginLeft: 10}}> Share & Embed </span>
          </Link>
          <Link
            style={styles.sidebarLink}
            to={"/m/"+this.props.conversation_id+"/comments"}>
            <Awesome name="comments"/>
            <span style={{marginLeft: 10}}> Comments </span>
          </Link>
          <Link
            style={styles.sidebarLink}
            to={"/m/"+this.props.conversation_id+"/participants"}>
            <Awesome name="users"/>
            <span style={{marginLeft: 10}}> Participants </span>
          </Link>
          <Link
            style={styles.sidebarLink}
            to={"/m/"+this.props.conversation_id+"/stats"}>
            <Awesome name="area-chart"/>
            <span style={{marginLeft: 10}}> Stats </span>
          </Link>
          <Link
            style={styles.sidebarLink}
            to={"/m/"+this.props.conversation_id+"/export"}>
            <Awesome name="cloud-download"/>
            <span style={{marginLeft: 10}}> Data export </span>
          </Link>
          <div style={styles.divider} />
          <a style={styles.sidebarLink} target="blank" href="http://docs.pol.is">
            <Awesome name="align-left"/><span style={{marginLeft: 10}}>Docs</span>
          </a>
          <a style={styles.sidebarLink} target="blank" href="https://twitter.com/UsePolis">
            <Awesome name="twitter"/><span style={{marginLeft: 10}}>@UsePolis</span>
          </a>
          <Link
            style={styles.sidebarLink}
            to={"/signout"}>
            <Awesome name="sign-out"/>
            <span style={{marginLeft: 10}}>Sign Out</span>
          </Link>
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