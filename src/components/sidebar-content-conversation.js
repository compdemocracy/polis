// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import Features from "../util/plan-features";
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

@connect(state => state.user)
@Radium
class SidebarContentConversation extends React.Component {

  handleClick() {
    if (this.props.onSidebarItemClicked) {
      this.props.onSidebarItemClicked();
    }
  }

  render() {
    let canEditReports = Features.canEditReports(this.props.user);
    let canViewStats = Features.canViewStats(this.props.user);
    let canExportData = Features.canExportData(this.props.user);

    return (
      <MaterialTitlePanel
        showHamburger={false}
        title={"Pol.is/"+this.props.conversation_id}
        style={this.props.style ? {...styles.sidebar, ...this.props.style} : styles.sidebar}>
        <div style={styles.content} onClick={this.handleClick.bind(this)}>
          <SidebarItem
            to="/"
            selected={false}
            icon="chevron-left"
            enabled={true}
            text="All Conversations"/>
          <SidebarItem
            to={"/m/"+this.props.conversation_id}
            selected={this.props.routes[2] && !this.props.routes[2].path}
            icon="gears"
            enabled={true}
            text="Configure"/>
          <SidebarItem
            to={"/m/"+this.props.conversation_id+"/live"}
            selected={this.props.routes[2] && this.props.routes[2].path === "live"}
            icon="heartbeat"
            enabled={true}
            text="See it"/>
          <SidebarItem
            to={"/m/"+this.props.conversation_id+"/share"}
            selected={this.props.routes[2] && this.props.routes[2].path === "share"}
            icon="code"
            enabled={true}
            text="Share & Embed"/>
          <SidebarItem
            to={"/m/"+this.props.conversation_id+"/comments"}
            selected={this.props.routes[2] && this.props.routes[2].path === "comments"}
            icon="comments"
            enabled={true}
            text="Comments"/>
          <SidebarItem
            to={"/m/"+this.props.conversation_id+"/participants"}
            selected={this.props.routes[2] && this.props.routes[2].path === "participants"}
            icon="users"
            enabled={true}
            text="Participants"/>
          {/*<SidebarItem
            to={"/m/"+this.props.conversation_id+"/summary"}
            selected={this.props.routes[2] && this.props.routes[2].path === "summary"}
            icon="list-alt"
            text="Summary"/>*/}
          <SidebarItem
            to={canViewStats ? "/m/"+this.props.conversation_id+"/stats" : Features.plansRoute}
            selected={this.props.routes[2] && this.props.routes[2].path === "stats"}
            icon="area-chart"
            enabled={canViewStats}
            text="Stats"/>
          <SidebarItem
            to={canEditReports ? "/m/"+this.props.conversation_id+"/reports" : Features.plansRoute}
            selected={this.props.routes[2] && this.props.routes[2].path === "reports"}
            icon="file-text-o"
            enabled={canEditReports}
            text="Reports"/>
          <SidebarItem
            to={canExportData ? "/m/"+this.props.conversation_id+"/export" : Features.plansRoute}
            selected={this.props.routes[2] && this.props.routes[2].path === "export"}
            icon="cloud-download"
            enabled={canExportData}
            text="Data Export"/>
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
