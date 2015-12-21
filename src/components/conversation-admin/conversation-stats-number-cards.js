import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Awesome from "react-fontawesome";
import Flex from "../framework/flex";

const style = {
  headline: {
    paddingLeft: 20
  },
  container: {
    padding: 20,
  },
  numberCard: {
    width: 200,
    height: 90,
    backgroundColor: "rgb(253,253,253)",
    marginRight: 7,
    marginBottom: 7,
    borderRadius: 3,
    padding: 10,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
  bigNumber: {
    display: "block",
    fontSize: 36,
    color: "rgb(160,160,160)",
  },
  numberAwesome: {
    fontSize: 24,
    marginLeft: 8,
    position: "relative",
    top: -3
  },
  numberSubheading: {
    fontSize: 16,
    fontWeight: 500,
    color: "rgb(160,160,160)"
  }
};

@Radium
class NumberCards extends React.Component {
  render() {
    const data = this.props.data
    return (
      <div style={style.container}>
        <Flex
          justifyContent={"flex-start"}
          align={"baseline"}>
          <div style={style.numberCard}>
            <span style={style.bigNumber}>
              { data.firstVoteTimes.length }
              <Awesome
                name="users"
                style={style.numberAwesome}/>
            </span>
            <span style={style.numberSubheading}> voted </span>
          </div>
          <div style={style.numberCard}>
            <span style={style.bigNumber}>
              { data.voteTimes.length }
              <Awesome name="tags" style={style.numberAwesome}/>
            </span>
            <span style={style.numberSubheading}> votes cast </span>
          </div>
          <div style={style.numberCard}>
            <span style={style.bigNumber}>
              { Math.floor(data.voteTimes.length / data.firstVoteTimes.length) }
            </span>
            <span style={style.numberSubheading}> votes per voter on average</span>
          </div>
        </Flex>
        <Flex
          justifyContent={"flex-start"}
          align={"baseline"}>
          <div style={style.numberCard}>
            <span style={style.bigNumber}>
              {data.firstCommentTimes.length}
              <Awesome
                name="users"
                style={style.numberAwesome}/>
            </span>
            <span style={style.numberSubheading}> commented</span>
          </div>
          <div style={style.numberCard}>
            <span style={style.bigNumber}>
              {data.commentTimes.length}
              <Awesome name="comments" style={style.numberAwesome}/>
            </span>
            <span style={style.numberSubheading}>comments submitted</span>
          </div>
          <div style={style.numberCard}>
            <span style={style.bigNumber}>
              { Math.floor(data.commentTimes.length / data.firstCommentTimes.length) }
            </span>
            <span style={style.numberSubheading}> comments per commenter on average </span>
          </div>
        </Flex>
      </div>
    );
  }
}

export default NumberCards;