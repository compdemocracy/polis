import React from "react";
// import _ from "lodash";
import Group from "./participantGroup";
import style from "../../util/style";
import * as globals from "../globals";
import Metadata from "./metadata";

class ParticipantGroups extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

    };
  }
  getStyles() {
    return {
      base: {

      }
    };
  }
  render() {
    const styles = this.getStyles();
    if (!this.props.conversation) {
      return <div>Loading Groups</div>;
    }
    return (
      <div style={Object.assign(
        {},
        styles.base,
        this.props.style
      )}>
      <div>
        <p style={globals.primaryHeading}> Opinion Groups </p>
        <p style={globals.paragraph}>
          Across {this.props.ptptCount} total participants, {this.props.math["group-votes"].length} opinion groups emerged. There are two factors that define an opinion group. First, each opinion group is made up of a number of participants who tended to vote similarly on multiple statements. Second, each group of participants who voted similarly will have also voted distinctly differently from other groups.
        </p>
      <Metadata
        math={this.props.math}
        comments={this.props.comments}
        conversation={this.props.conversation}
        ptptCount={this.props.ptptCount}
        voteColors={this.props.voteColors}
        formatTid={this.props.formatTid}/>
      {
        this.props.math && this.props.comments ? _.map(this.props.math["repness"], (groupComments, gid) => {
          gid = Number(gid);

          let otherGroupVotes = {
            votes: [],
            "n-members": 0,
          };

          let MAX_CLUSTERS = 50;
          let temp = this.props.math["group-votes"];
          for (let ogid = 0; ogid < MAX_CLUSTERS; ogid++) {
            if (ogid === gid || !temp[ogid]) {
              continue;
            }
            otherGroupVotes["n-members"] += temp[ogid]["n-members"];
            let commentVotes = temp[ogid].votes;
            _.each(commentVotes, (voteObj, tid) => {
              tid = Number(tid);
              if (voteObj) {
                if (!otherGroupVotes.votes[tid]) {
                  otherGroupVotes.votes[tid] = {A: 0, D: 0, S: 0};
                }
                otherGroupVotes.votes[tid].A += voteObj.A;
                otherGroupVotes.votes[tid].D += voteObj.D;
                otherGroupVotes.votes[tid].S += voteObj.S;

              }
            });
          }
          return (
            <Group
              key={gid}
              comments={this.props.comments}
              gid={gid}
              conversation={this.props.conversation}
              demographicsForGroup={this.props.demographics[gid]}
              groupComments={groupComments}
              groupName={this.props.groupNames[gid]}
              groupVotesForThisGroup={this.props.math["group-votes"][gid]}
              groupVotesForOtherGroups={otherGroupVotes}
              formatTid={this.props.formatTid}
              ptptCount={this.props.ptptCount}
              groupNames={this.props.groupNames}
              badTids={this.props.badTids}
              repfulAgreeTidsByGroup={this.props.repfulAgreeTidsByGroup}
              repfulDisageeTidsByGroup={this.props.repfulDisageeTidsByGroup}
              math={this.props.math}
              report={this.props.report}
              voteColors={this.props.voteColors}

              />
          );
        }) : "Loading Groups"
      }
      </div>
      </div>
    );
  }
}

export default ParticipantGroups;
