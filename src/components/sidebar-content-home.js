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
    height: '100%',
    backgroundColor: 'white',
  },
};

@Radium
class SidebarContentHome extends React.Component {
  render() {
    return (
      <MaterialTitlePanel
        showHamburger={false}
        title="Pol.is"
        hamburger={this.props.hamburger}
        style={this.props.style ? {...styles.sidebar, ...this.props.style} : styles.sidebar}>
        <div style={styles.content}>
          <Link
            style={styles.sidebarLink}
            to="/new">
            <Awesome name="plus"/>
            <span style={{marginLeft: 10}}> New </span>
            </Link>
          <Link
            style={styles.sidebarLink}
            to="/integrate">
            <Awesome name="code"/>
            <span style={{marginLeft: 10}}> Integrate </span>
          </Link>
          <Link
            style={styles.sidebarLink}
            to="/conversations">
            <Awesome name="inbox"/>
            <span style={{marginLeft: 10}}> Conversations </span>
          </Link>
          <Link
            style={styles.sidebarLink}
            to="/account">
            <Awesome name="credit-card"/>
            <span style={{marginLeft: 10}}> Account </span>
            </Link>
          <div style={styles.divider} />
          <a style={styles.sidebarLink} target="blank" href="http://docs.pol.is">
            <Awesome name="align-left"/><span style={{marginLeft: 10}}>Docs</span>
          </a>
          <a style={styles.sidebarLink} target="blank" href="https://twitter.com/UsePolis">
            <Awesome name="twitter"/><span style={{marginLeft: 10}}>@UsePolis</span>
          </a>
        </div>
      </MaterialTitlePanel>
    );
  }
}

export default SidebarContentHome;

/*
  Todo
    make new button point to config of fresh convo
*/


// <p>
//   <Awesome name="home" style={{fontSize: 24, cursor: "pointer"}}/>
//   Polis Home
// </p>
// <div>
//   { this.props.user ? this.props.user.hname : /*<Spinner/>*/ "o" }
// </div>


          // <Link
          //   style={styles.sidebarLink}
          //   to="/overall-stats">
          //   Overall Stats
          // </Link>