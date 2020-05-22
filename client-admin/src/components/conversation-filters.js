// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
// import _ from 'lodash';
import Flex from "./framework/flex";
// import { connect } from 'react-redux';
// import { FOO } from '../actions';

// const style = {
// };

// @connect(state => {
//   return state.FOO;
// })
@Radium
class ComponentName extends React.Component {
  constructor(props) {
    super(props);
    this.state = {};
  }

  getStyles() {
    return {
      input: {
        display: "block",
        margin: 10,
        color: "rgb(100,100,100)",
        fontSize: 14,
        padding: 7,
        borderRadius: 3,
        border: "1px solid rgba(240,240,240,1)",
      },
      container: {
        maxWidth: 600,
      },
    };
  }
  render() {
    const styles = this.getStyles();
    return (
      <Flex
        direction="row"
        wrap="wrap"
        justifyContent="flex-start"
        styleOverrides={styles.container}
      >
        {"Filter by number of participants: "}
        <input
          style={[styles.input]}
          type="text"
          onChange={this.props.handleFilterChange}
          placeholder="# of participants"
        />
      </Flex>
    );
  }
}

export default ComponentName;
