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
  chartCard: {
    backgroundColor: "rgb(253,253,253)",
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
  componentWillMount() {
    this.getStatsRepeatedly = setInterval(()=>{
      this.loadStats();
    }, 10000);
  }
  componentDidMount() {
  }
  componentWillUnmount() {
    clearInterval(this.getStatsRepeatedly);
  }
  createCharts(data) {
    return (
      <div ref="chartContainer">
        <Flex direction="column" justifyContent="center" styleOverrides={{width: "100%"}}>
          <NumberCards data={data}/>
          <Flex
            wrap="wrap"
            justifyContent="space-around">
            <div style={style.chartCard}>
              <h3 style={{marginBottom: 0, marginLeft: 50}}>
                <span style={{color: "gold"}}>Voters </span>
                <span style={{color: "tomato"}}>Commenters</span>
              </h3>
              <CommentersVoters
                chartHeight={this.refs.chartContainer ?
                  (this.refs.chartContainer.offsetWidth * .45) :
                  400 }
                chartWidth={this.refs.chartContainer ?
                  (this.refs.chartContainer.offsetWidth * .9) :
                  (window.innerWidth * .5) }
                data={data}/>
            </div>
            <div style={style.chartCard}>
              <h3 style={{marginBottom: 0, marginLeft: 50}}>
                <span style={{color: "tomato"}}>Comments</span>
              </h3>
              <CommentsTimescale
                chartHeight={this.refs.chartContainer ?
                  (this.refs.chartContainer.offsetWidth * .45) :
                  400 }
                chartWidth={this.refs.chartContainer ?
                  (this.refs.chartContainer.offsetWidth * .9) :
                  (window.innerWidth * .5) }
                data={data}/>
            </div>
            <div style={style.chartCard}>
              <h3 style={{marginBottom: 0, marginLeft: 50}}>
                <span style={{color: "gold"}}>Votes</span>
              </h3>
              <Votes
                chartHeight={this.refs.chartContainer ?
                  (this.refs.chartContainer.offsetWidth * .45) :
                  400 }
                chartWidth={this.refs.chartContainer ?
                  (this.refs.chartContainer.offsetWidth * .9) :
                  (window.innerWidth * .5) }
                data={data}/>
            </div>
            <div style={style.chartCard}>
              <h3 style={{marginBottom: 0, marginLeft: 50}}>
                <span>Votes per participant distribution</span>
              </h3>
              <VotesDistribution
                chartHeight={this.refs.chartContainer ?
                  (this.refs.chartContainer.offsetWidth * .45) :
                  400 }
                chartWidth={this.refs.chartContainer ?
                  (this.refs.chartContainer.offsetWidth * .9) :
                  (window.innerWidth * .5) }
                data={data}/>
            </div>
          </Flex>
        </Flex>
      </div>
    );
  }
  render() {
    return (
      <div>
        {
          this.props.conversation_stats.voteTimes ?
            this.createCharts(this.props.conversation_stats) :
            <Spinner/>
        }
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
