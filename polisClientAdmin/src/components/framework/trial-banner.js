// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";

const styles = {
  root: {
    fontWeight: 300,
  },
  header: {
    backgroundColor: "rgba(3, 169, 244,.5)",
    color: "white",
    padding: "16px",
    fontSize: "1em"
  }
};

const TrialBanner = (props) => {
  const rootStyle = props.style ? {...styles.root, ...props.style} : styles.root;

  return (
    <div style={rootStyle}>
      {
        false ?
          <div style={styles.header}>
            { props.title }
          </div> : ""
      }
      {props.children}
    </div>
  );
};

export default TrialBanner;
