// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import dateSetupUtil from "../../../util/data-export-date-setup";
import React from "react";
import { connect } from "react-redux";
import { populateConversationStatsStore } from "../../../actions";
import _ from "lodash";
import NumberCards from "./conversation-stats-number-cards";
import Votes from "./conversation-stats-votes-timescale";
import VotesDistribution from "./conversation-stats-vote-distribution";
import CommentsTimescale from "./conversation-stats-comments-timescale";
import CommentersVoters from "./conversation-stats-commenters-voters";

@connect((state) => state.stats)
class ConversationStats extends React.Component {
  constructor(props) {
    super(props);
    var times = dateSetupUtil();
    this.state = Object.assign({}, times);
  }

  handleUntilButtonClicked() {
    const year = this.refs.exportSelectYear.value;
    const month = this.refs.exportSelectMonth.value;
    const dayOfMonth = this.refs.exportSelectDay.value;
    const tz = this.refs.exportSelectHour.value;
    const dateString = [month, dayOfMonth, year, tz].join(" ");
    const dddate = new Date(dateString);
    const until = Number(dddate);
    this.setState(
      {
        until: until,
      },
      function () {
        this.loadStats();
      }
    );
  }
  loadStats() {
    const { match } = this.props;

    var until = this.state.until;
    this.props.dispatch(populateConversationStatsStore(match.params.conversation_id, until));
  }
  componentWillMount() {
    this.loadStats();
    this.getStatsRepeatedly = setInterval(() => {
      this.loadStats();
    }, 10000);
  }
  componentDidMount() {}
  componentWillUnmount() {
    clearInterval(this.getStatsRepeatedly);
  }
  createCharts(data) {
    return (
      <div ref="chartContainer">
        <div>
          <NumberCards data={data} />
          <div>
            <div>
              <h3>
                <span style={{ color: "gold" }}>Voters </span>
                <span style={{ color: "tomato" }}>Commenters</span>
              </h3>
              <CommentersVoters
                chartHeight={
                  this.refs.chartContainer ? this.refs.chartContainer.offsetWidth * 0.45 : 400
                }
                chartWidth={
                  this.refs.chartContainer
                    ? this.refs.chartContainer.offsetWidth * 0.9
                    : window.innerWidth * 0.5
                }
                data={data}
              />
            </div>
            <div>
              <h3>
                <span style={{ color: "tomato" }}>Comments</span>
              </h3>
              <CommentsTimescale
                chartHeight={
                  this.refs.chartContainer ? this.refs.chartContainer.offsetWidth * 0.45 : 400
                }
                chartWidth={
                  this.refs.chartContainer
                    ? this.refs.chartContainer.offsetWidth * 0.9
                    : window.innerWidth * 0.5
                }
                data={data}
              />
            </div>
            <div>
              <h3>
                <span style={{ color: "gold" }}>Votes</span>
              </h3>
              <Votes
                chartHeight={
                  this.refs.chartContainer ? this.refs.chartContainer.offsetWidth * 0.45 : 400
                }
                chartWidth={
                  this.refs.chartContainer
                    ? this.refs.chartContainer.offsetWidth * 0.9
                    : window.innerWidth * 0.5
                }
                data={data}
              />
            </div>
            <div>
              <h3>
                <span>Votes per participant distribution</span>
              </h3>
              <VotesDistribution
                chartHeight={
                  this.refs.chartContainer ? this.refs.chartContainer.offsetWidth * 0.45 : 400
                }
                chartWidth={
                  this.refs.chartContainer
                    ? this.refs.chartContainer.offsetWidth * 0.9
                    : window.innerWidth * 0.5
                }
                data={data}
              />
            </div>
          </div>
        </div>

        <select ref="exportSelectYear">
          {this.state.years.map((year, i) => {
            return (
              <option selected={year.selected} key={i} value={year.name}>
                {" "}
                {year.name}{" "}
              </option>
            );
          })}
        </select>
        <select ref="exportSelectMonth">
          {this.state.months.map((month, i) => {
            return (
              <option selected={month.selected} key={i} value={month.name}>
                {" "}
                {month.name}{" "}
              </option>
            );
          })}
        </select>
        <select ref="exportSelectDay">
          {this.state.days.map((day, i) => {
            return (
              <option selected={day.selected} key={i} value={day.name}>
                {" "}
                {day.name}{" "}
              </option>
            );
          })}
        </select>
        <select
          style={{
            marginRight: 10,
            cursor: "pointer",
            fontSize: 16,
          }}
          ref="exportSelectHour"
        >
          {this.state.tzs.map((tz, i) => {
            return (
              <option selected={tz.selected} key={i} value={tz.name}>
                {" "}
                {tz.name}{" "}
              </option>
            );
          })}
        </select>
        <button onClick={this.handleUntilButtonClicked.bind(this)}>Set Until</button>
      </div>
    );
  }

  render() {
    return (
      <div>
        {this.props.conversation_stats.voteTimes
          ? this.createCharts(this.props.conversation_stats)
          : "Loading..."}
      </div>
    );
  }
}

export default ConversationStats;
