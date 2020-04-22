// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Awesome from "react-fontawesome";
import {Link} from "react-router";
import MaterialTitlePanel from "./material-title-panel-sidebar";
import SidebarItem from "./sidebar-item";

const styles = {
  sidebar: {
    width: 256,
    height: "100%"
  },
  sidebarLink: {
    display: "block",
    padding: "16px 0px 16px 16px",
    color: "#757575",
    textDecoration: "none"
  },
  divider: {
    height: 1,
    backgroundColor: "#757575"
  },
  content: {
    height: "100%",
    backgroundColor: "white"
  }
};

@Radium
class SidebarContentReport extends React.Component {

  handleClick() {
    if (this.props.onSidebarItemClicked) {
      this.props.onSidebarItemClicked();
    }
  }

  render() {
    let p = this.props.params;
    console.log(this.props.routes);
    return (
      <MaterialTitlePanel
        showHamburger={false}
        title={"Pol.is/"+this.props.report_id}
        style={this.props.style ? {...styles.sidebar, ...this.props.style} : styles.sidebar}>
        <div style={styles.content} onClick={this.handleClick.bind(this)}>
          <SidebarItem
            to={"/m/" + p.conversation_id + "/reports"}
            selected={false}
            icon="chevron-left"
            text="All Reports"/>
          <SidebarItem
            to={"/m/"+p.conversation_id + "/reports/" + p.report_id}
            selected={this.props.routes[4] && !this.props.routes[4].path}
            icon="gears"
            text="Configure Report"/>
          <SidebarItem
            to={"/m/"+p.conversation_id + "/reports/" + p.report_id + "/comments"}
            selected={this.props.routes[4] && this.props.routes[4].path === "comments"}
            icon="comments"
            text="Matrix Comments"/>
          <div style={styles.divider} />
          <a style={styles.sidebarLink} target="blank" href="http://docs.pol.is">
            <Awesome name="align-left"/><span style={{marginLeft: 10}}>Docs</span>
          </a>
          <a style={styles.sidebarLink} target="blank" href="https://twitter.com/UsePolis">
            <Awesome style={{color: "#4099FF"}} name="twitter"/><span style={{marginLeft: 10}}>@UsePolis</span>
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

export default SidebarContentReport;

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
