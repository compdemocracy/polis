import Button from "../framework/generic-button";
import dateSetupUtil from "../../util/data-export-date-setup";
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
import StarsSpinner from "../framework/stars-spinner";

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
    var times = dateSetupUtil();
    this.state = Object.assign({},times);
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
  handleUntilButtonClicked() {
    const year = this.refs.exportSelectYear.value;
    const month = this.refs.exportSelectMonth.value;
    const dayOfMonth = this.refs.exportSelectDay.value;
    const tz = this.refs.exportSelectHour.value;
    const dateString = [month, dayOfMonth, year, tz].join(" ");
    const dddate = new Date(dateString);
    const until = Number(dddate);
    this.setState({
      until: until,
    }, function() {
      this.loadStats();
    });
  }
  loadStats() {
    var until = this.state.until;
    this.props.dispatch(
      populateConversationStatsStore(this.props.params.conversation_id, until)
    );
  }
  componentWillMount() {
    this.loadStats();
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

        <select
            style={{
              marginRight: 10,
              cursor: "pointer",
              fontSize: 16,
            }}
            ref="exportSelectYear">
            {
              this.state.years.map((year, i) => {
                return (
                  <option selected={year.selected} key={i} value={year.name}> {year.name} </option>
                )
              })
            }
          </select>
          <select
            style={{
              marginRight: 10,
              cursor: "pointer",
              fontSize: 16,

            }}
            ref="exportSelectMonth">
            {
              this.state.months.map((month, i)=>{
                return (
                  <option selected={month.selected} key={i} value={month.name}> {month.name} </option>
                )
              })
            }
          </select>
          <select
            style={{
              marginRight: 10,
              cursor: "pointer",
              fontSize: 16,

            }}
            ref="exportSelectDay">
            {
              this.state.days.map((day, i)=>{
                return (
                  <option selected={day.selected} key={i} value={day.name}> {day.name} </option>
                );
              })
            }
          </select>
          <select
            style={{
              marginRight: 10,
              cursor: "pointer",
              fontSize: 16,
            }}
            ref="exportSelectHour">
            {
              this.state.tzs.map((tz, i) => {
                return (
                  <option selected={tz.selected} key={i} value={tz.name}> {tz.name} </option>
                );
              })
            }
          </select>
          <Button
            style={{
              backgroundColor: "#03a9f4",
              color: "white",
              marginTop: 20,
            }}
            onClick={this.handleUntilButtonClicked.bind(this)}
            >
            Set Until
          </Button>
      </div>
    );
  }
  renderSpinner() {
    return (
      <StarsSpinner
        text={"Crunching the numbers, hold on a sec..."}
        nodeColor={ "rgb(150,150,150)" }
        count={ Math.floor(window.innerWidth / 10) }
        width={ window.innerWidth }
        height={ window.innerHeight }
        radius={ 1.5 }
        lineWidth={ 1 }/>
    );
  }
  render() {
    return (
      <div>
        {
          this.props.conversation_stats.voteTimes ?
            this.createCharts(this.props.conversation_stats) :
            this.renderSpinner()
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
