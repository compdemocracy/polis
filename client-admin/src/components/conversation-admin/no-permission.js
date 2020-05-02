// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import Awesome from "react-fontawesome";
import strings from "../../strings/strings";

const cardPadding = 10;
const cardBorderRadius = 3;

const styles = {
  card: {
    margin: "10px 20px 10px 20px",
    backgroundColor: "rgb(253,253,253)",
    borderRadius: 3,
    padding: "10px 10px",
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
  notification: {
    fontSize: 16,
    fontWeight: 500,
    color: "rgb(160,160,160)"
  }
}

@Radium
class NoPermission extends React.Component {
  render() {
    return (
      <div style={styles.card}>
        <div style={styles.notification}>{strings("no_permission")}</div>
      </div>
    );
  }
}

export default NoPermission;
