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
