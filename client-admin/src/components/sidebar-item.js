// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import {Link} from "react-router";
import Awesome from "react-fontawesome";
import {s} from "./framework/global-styles";

@Radium
class SidebarItem extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

    };
  }
  static propTypes = {
    /* react */
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
    /* component api */
    enabled: React.PropTypes.bool,
    style: React.PropTypes.object,
    selected: React.PropTypes.bool,
    to: React.PropTypes.string,
    icon: React.PropTypes.string
  }
  static defaultProps = {
    enabled: true,
  }
  getStyles() {
    let color = {
      fontWeight: this.props.selected ? 500 : 300,
    };
    let disabled = Object.assign({}, color, {
      color: "rgba(100,100,100,.5)",
    });
    const small = {
      fontSize: 14,
      padding: 0,
      margin: "0px 0px 20px 20px",
    }
    return {
      color: color,
      disabled: disabled,
      small: small,
    };
  }
  render() {
    const styles = this.getStyles();

    return (
      <Link
        to={this.props.to}
        style={
          Object.assign(
            {},
            s.sidebarLink,
            this.props.enabled ? styles.color : styles.disabled,
            this.props.small ? styles.small : {}
          )
        }>
        <span style={{position: "relative", left: -5}}> {this.props.showIcon ? <Awesome name={this.props.icon} /> : null} </span>
        {this.props.text}
      </Link>
    );
  }
}

export default SidebarItem;
