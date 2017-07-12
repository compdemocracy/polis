// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import Features from "../util/plan-features";
import { lockedIcon} from "../util/plan-features";
import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Awesome from "react-fontawesome";
import {Link} from "react-router";
import MaterialTitlePanel from "./material-title-panel-sidebar";
import SidebarItem from "./sidebar-item";
import {s} from "./framework/global-styles";

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
        style={this.props.style ? {...s.sidebar, ...this.props.style} : s.sidebar}>
        <div style={s.sidebarLinks} onClick={this.handleClick.bind(this)}>
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
          {/*<SidebarItem
            to={"/m/"+this.props.conversation_id+"/live"}
            selected={this.props.routes[2] && this.props.routes[2].path === "live"}
            icon="heartbeat"
            enabled={true}
            text="See it"/>*/}
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
            text={"Stats" + (canViewStats ? "" : lockedIcon)}/>
          <SidebarItem
            to={canEditReports ? "/m/"+this.props.conversation_id+"/reports" : Features.plansRoute}
            selected={this.props.routes[2] && this.props.routes[2].path === "reports"}
            icon="file-text-o"
            enabled={canEditReports}
            text={"Reports" + (canEditReports ? "" : lockedIcon)}/>
          <SidebarItem
            to={canExportData ? "/m/"+this.props.conversation_id+"/export" : Features.plansRoute}
            selected={this.props.routes[2] && this.props.routes[2].path === "export"}
            icon="cloud-download"
            enabled={canExportData}
            text={"Data Export" + (canExportData ? "" : lockedIcon)}/>
          <a style={Object.assign({}, s.sidebarLink, {marginTop: 40})} target="blank" href="http://docs.pol.is">
            <span style={{marginRight: 10}}>Docs</span><Awesome name="external-link"/>
          </a>
          <Link
            style={s.sidebarLink}
            to={"/signout"}>
            <span style={{marginRight: 10}}>Sign Out</span>
            <Awesome name="sign-out"/>
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
