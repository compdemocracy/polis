// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
// import _ from "lodash";
// import Flex from "./framework/flex";
import {Link} from "react-router";
import Awesome from "react-fontawesome";

@Radium
class SidebarItem extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

    };
  }
  static propTypes = {
    /* react */
    // dispatch: React.PropTypes.func,
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
    // foo: "bar"
  }
  getStyles() {
    let base = {
      display: "block",
      padding: "16px 0px 16px 16px",
      color: this.props.selected ? "white" : "#757575",
      backgroundColor: this.props.selected ? "#03a9f4" : "white",
      textDecoration: "none",
      cursor: "pointer"
    };
    let disabled = Object.assign({}, base, {
      color: "#959595",
    });
    return {
      base: base,
      disabled: disabled,
    };
  }
  render() {
    const styles = this.getStyles();

    return (
      <Link
        to={this.props.to}
        style={this.props.enabled ? styles.base : styles.disabled}>
        <Awesome style={{marginRight: 10}} name={this.props.icon}/>
        {` `}
        {this.props.text}
      </Link>
    );
  }
}

export default SidebarItem;
