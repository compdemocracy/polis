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
class SidebarContentHome extends React.Component {
  render() {
    return (
      <MaterialTitlePanel
        title="Pol.is"
        hamburger={this.props.hamburger}
        style={this.props.style ? {...styles.sidebar, ...this.props.style} : styles.sidebar}>
        <div style={styles.content}>
          <Link
            style={styles.sidebarLink}
            to="/new">
            New
          </Link>
          <Link
            style={styles.sidebarLink}
            to="/integrate">
            Integrate
          </Link>
          <Link
            style={styles.sidebarLink}
            to="/conversations">
            Conversations
          </Link>
          <Link
            style={styles.sidebarLink}
            to="/account">
            Account
          </Link>
          <div style={styles.divider} />
          <a
            style={styles.sidebarLink}
            href="http://docs.pol.is">
            Docs
          </a>
          <a
            style={styles.sidebarLink}
            href="https://twitter.com/UsePolis">
            <Awesome name="twitter"/> @UsePolis
          </a>
        </div>
      </MaterialTitlePanel>
    );
  }
}

export default SidebarContentHome;

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