// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import _ from "lodash";
import Awesome from "react-fontawesome";
import Flex from "../framework/flex";
import NumberCard from "./conversation-stats-number-card";

@Radium
class NumberCards extends React.Component {
  static propTypes = {
    dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    data: React.PropTypes.object,
  }
  render() {
    const data = this.props.data
    return (
      <Flex
        justifyContent="space-around"
        alignItems="flex-start"
        wrap="wrap">
        <NumberCard
          datum={data.firstVoteTimes.length}
          subheading="voted"
          icon="users"/>
        <NumberCard
          datum={data.voteTimes.length}
          subheading="votes cast"
          icon="tags"/>
        <NumberCard
          datum={ (data.voteTimes.length / data.firstVoteTimes.length).toFixed(2) }
          subheading="votes per voter on average"/>
        <NumberCard
          datum={ data.firstCommentTimes.length }
          subheading="commented"
          icon="users"/>
        <NumberCard
          datum={ data.commentTimes.length }
          subheading="comments submitted"
          icon="comments"/>
        <NumberCard
          datum={ (data.commentTimes.length / data.firstCommentTimes.length).toFixed(2) }
          subheading="comments per commenter on average"/>
      </Flex>
    );
  }
}

export default NumberCards;
