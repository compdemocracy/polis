import React from "react";
import {connect} from "react-redux";
import Radium from "radium";
import {populateConversationStatsStore} from "../../actions";
import _ from "lodash";
import Spinner from "../framework/spinner";
import Flex from "../framework/flex";
import NumberCards from "./conversation-stats-number-cards";
import Votes from "./conversation-stats-votes-timescale";
import VotesDistribution from "./conversation-stats-vote-distribution";
import CommentsTimescale from "./conversation-stats-comments-timescale";
import CommentersVoters from "./conversation-stats-commenters-voters";

const style = {
  container: {
    backgroundColor: "rgb(240,240,247)",
  },
  chartCard: {
    backgroundColor: "rgb(253,253,253)",
    marginRight: 14,
    marginBottom: 14,
    borderRadius: 3,
    padding: 10,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
  },
};

@connect((state) => state.stats)
@Radium
class ConversationStats extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      chartContainer: 360 // untrue, just smallest size it's likely to be
    };
  }
  static propTypes = {
    dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    conversation_stats: React.PropTypes.object,
  }
  static defaultProps = {
    style: {
      backgroundColor: "orange",
      color: "white"
    }
  }
  loadStats() {
    this.props.dispatch(
      populateConversationStatsStore(this.props.params.conversation_id)
    );
  }
  onWindowResize() {
    this.setState(this.refs.chartContainer.offsetWidth)
  }
  throttledWindowResize() {
    return _.throttle(this.onWindowResize, 500)
  }
  componentWillMount() {
    this.getStatsRepeatedly = setInterval(()=>{
      this.loadStats();
    }, 10000);
    window.addEventListener("resize", this.throttledWindowResize().bind(this))
  }
  componentDidMount() {
  }
  componentWillUnmount() {
    clearInterval(this.getStatsRepeatedly);
    window.removeEventListener("resize", this.throttledWindowResize().bind(this))
  }
  createCharts(data) {
    console.log("STATE", this.state)
    return (
      <div ref="chartContainer" style={style.container}>
          <NumberCards containerWidth={this.state.containerWidth} data={data}/>
          <Flex
            wrap="wrap"
            justifyContent="flex-start">
            <div style={style.chartCard}>
              <h3 style={{marginBottom: 0, marginLeft: 50}}>
                <span style={{color: "gold"}}>Voters </span>
                <span style={{color: "tomato"}}>Commenters</span>
              </h3>
              <CommentersVoters containerWidth={this.state.containerWidth} data={data}/>
            </div>
            <div style={style.chartCard}>
              <h3 style={{marginBottom: 0, marginLeft: 50}}>
                <span style={{color: "tomato"}}>Comments</span>
              </h3>
              <CommentsTimescale containerWidth={this.state.containerWidth} data={data}/>
            </div>
            <div style={style.chartCard}>
              <h3 style={{marginBottom: 0, marginLeft: 50}}>
                <span style={{color: "gold"}}>Votes</span>
              </h3>
              <Votes containerWidth={this.state.containerWidth} data={data}/>
            </div>
            <div style={style.chartCard}>
              <h3 style={{marginBottom: 0, marginLeft: 50}}>
                <span>Votes per participant distribution</span>
              </h3>
              <VotesDistribution containerWidth={this.state.containerWidth} data={data}/>
            </div>
        </Flex>
      </div>
    );
  }
  render() {
    const data = this.props.conversation_stats; /* swap out for real data later */
    return (
      <div>
        {data.voteTimes ? this.createCharts(data) : <Spinner/>}
      </div>
    );
  }
}

export default ConversationStats;

// var styles = (i) => {
//   return {
//     backgroundColor: `rgb(${i * 50}, 50, 50)`
//   };
// };
