import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
// import _ from "lodash";
import Awesome from "react-fontawesome";
import {Link} from "react-router";
import MaterialTitlePanel from "./material-title-panel-sidebar";
import {handleCreateConversationSubmit} from "../actions";
import SidebarItem from "./sidebar-item";

const styles = {
  sidebar: {
    width: 256,
    height: "100%",
  },
  sidebarLink: {
    display: "block",
    padding: "16px 0px 16px 16px",
    color: "#757575",
    textDecoration: "none",
    cursor: "pointer"
  },
  divider: {
    height: 1,
    backgroundColor: "#757575",
  },
  content: {
    height: "100%",
    backgroundColor: "white",
  }
};

@connect((state) => state.zid_metadata)
@Radium
class SidebarContentHome extends React.Component {
  static propTypes = {
    /* react */
    dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
    /* component api */
    styles: React.PropTypes.object,
    // foo: React.PropTypes.string
  }
  onNewClicked() {
    this.props.dispatch(handleCreateConversationSubmit());
  }

  handleClick() {
    if (this.props.onSidebarItemClicked) {
      this.props.onSidebarItemClicked();
    }
  }

  render() {
    return (
      <MaterialTitlePanel
        showHamburger={false}
        title="pol.is"
        style={this.props.style ? {...styles.sidebar, ...this.props.style} : styles.sidebar}>
        <div style={styles.content} onClick={this.handleClick.bind(this)}>
          <span
            style={styles.sidebarLink}
            onClick={this.onNewClicked.bind(this)}>
            <Awesome name="plus"/>
            <span style={{marginLeft: 10}}> New </span>
          </span>

          <SidebarItem
            to="/integrate"
            selected={this.props.routes[1] && this.props.routes[1].path === "integrate"}
            icon="code"
            text="Integrate"/>
          <SidebarItem
            to="/"
            selected={this.props.routes[1] && !this.props.routes[1].path}
            icon="inbox"
            text="My Conversations"/>
          <SidebarItem
            to="/other-conversations"
            selected={this.props.routes[1] && this.props.routes[1].path === "other-conversations"}
            icon="user"
            text="Other Conversations"/>
          {/*<SidebarItem
            to="/account"
            selected={false}
            icon="credit-card"
            text="Account"/>*/}

          <div style={styles.divider} />

          <a style={styles.sidebarLink} target="blank" href="http://docs.pol.is">
            <Awesome name="align-left"/><span style={{marginLeft: 10}}>Docs</span>
          </a>
          <a style={styles.sidebarLink} target="blank" href="https://twitter.com/UsePolis">
            <Awesome style={{color: "#4099FF"}} name="twitter"/>
              <span
                style={{
                  marginLeft: 10
                }}>
                @UsePolis
              </span>
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
