// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
// import _ from "lodash";
import Awesome from "react-fontawesome";
import {Link} from "react-router";
import MaterialTitlePanel from "./material-title-panel-sidebar";
import {handleCreateConversationSubmit} from "../actions";
import SidebarItem from "./sidebar-item";
import {s} from "./framework/global-styles";

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
        style={this.props.style ? {...s.sidebar, ...this.props.style} : s.sidebar}>
        <div style={s.sidebarLinks} onClick={this.handleClick.bind(this)}>

          <span
            style={s.sidebarLink}
            onClick={this.onNewClicked.bind(this)}>
            <span>New</span>
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
          <SidebarItem
            to="/account"
            selected={false}
            icon="credit-card"
            text="Account"/>

          <a style={Object.assign({}, s.sidebarLink, {marginTop: 40})} target="blank" href="http://docs.pol.is">
            <span style={{marginRight: 10}}>Docs</span><Awesome name="external-link"/>
          </a>
          <Link
            style={s.sidebarLink}
            to={"/signout"}>
            <span style={{marginRight: 10}}>Sign Out</span><Awesome name="sign-out"/>
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
//   style={s.sidebarLink}
//   to="/overall-stats">
//   Overall Stats
// </Link>
