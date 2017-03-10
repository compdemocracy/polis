import React from "react";
import Comment from "./participantGroupComment";
import * as globals from "./globals";
import Flex from "./flex"
import style from "../util/style";

const ParticipantGroup = ({gid, groupComments, conversation, allComments, groupVotesForThisGroup, groupVotesForOtherGroups, demographicsForGroup, ptptCount, groupName, formatTid}) => {

  const drawGroupComments = () => {
    const allCommentsKeyed = _.keyBy(allComments, "tid");

    return groupComments.map((c, i) => {
      if (!allCommentsKeyed[c.tid]) {
        console.log('modded out?', c.tid);
        return "";
      }
      // const groupVotes = math["group-votes"][gid].votes[comment.tid];
      // const isBestAgree = comment["best-agree"] && (groupVotes && groupVotes.A > 0);
      // const agree = isBestAgree || comment["repful-for"] === "agree";
      // const percent = agree ?
      // Math.floor(groupVotes.A / groupVotes.S * 100) :
      // Math.floor(groupVotes.D / groupVotes.S * 100);
      return <Comment
        conversation={conversation}
        key={i}
        index={i}
        comment={allCommentsKeyed[c.tid]}
        formatTid={formatTid}
        groupVotesForThisGroup={groupVotesForThisGroup}
        groupVotesForOtherGroups={groupVotesForOtherGroups}
        ptptCount={ptptCount}/>

    })
  }

  function drawGroupMetadataComments() {
    const allCommentsKeyed = _.keyBy(allComments, "tid");
    let tidToAds = {};
    let a = demographicsForGroup.meta_comment_agrees;
    let a_tids = _.keys(a);
    let d = demographicsForGroup.meta_comment_disagrees;
    let d_tids = _.keys(d);
    let p = demographicsForGroup.meta_comment_passes;
    let p_tids = _.keys(p);
    let allTids = {};
    for (let i = 0; i < a_tids.length; i++) {
      let tid = a_tids[i];
      tidToAds[tid] = tidToAds[tid] || {A: 0, D: 0, S: 0};
      tidToAds[tid].A = a[tid] + tidToAds[tid].A;
      tidToAds[tid].S = a[tid] + tidToAds[tid].S;
      allTids[tid] = true;
    }
    for (let i = 0; i < d_tids.length; i++) {
      let tid = d_tids[i];
      tidToAds[tid] = tidToAds[tid] || {A: 0, D: 0, S: 0};
      tidToAds[tid].D = d[tid] + tidToAds[tid].D;
      tidToAds[tid].S = d[tid] + tidToAds[tid].S;
      allTids[tid] = true;
    }
    for (let i = 0; i < p_tids.length; i++) {
      let tid = p_tids[i];
      tidToAds[tid] = tidToAds[tid] || {A: 0, D: 0, S: 0};
      tidToAds[tid].S = p[tid] + tidToAds[tid].S;
      allTids[tid] = true;
    }

    let groupVotes = {
      votes: tidToAds,
    };
    // debugger;
    return _.keys(allTids).map((tid, i) => {
      return <Comment
        conversation={conversation}
        key={tid}
        index={i}
        comment={allCommentsKeyed[tid]}
        formatTid={formatTid}
        groupVotesForThisGroup={groupVotes}
        ptptCount={ptptCount}/>;
    });
        // groupVotesForOtherGroups={groupVotesForOtherGroups}
  }



  let demo = demographicsForGroup;
  let currentYear = (new Date()).getUTCFullYear();

  return (
    <div
      style={{
        marginBottom: 20,
        width: "100%",

      }}>
      <div style={{
          marginBottom: 20,
          fontSize: globals.secondaryHeading
        }}>
        <span>
          <span>
            "{groupName}"
          </span>
          <svg width="1em"height="1em" style={{border: "none", marginLeft: 10, marginRight: 10}}>
            <circle
              r={5}
              fill={globals.groupColor(gid)}
              cx={10}
              cy={12}/>
          </svg>
        </span>
        <span>{groupVotesForThisGroup["n-members"]} PARTICIPANTS</span>
      </div>
        <Flex justifyContent={"flex-start"} alignItems={"baseline"} styleOverrides={{width: "100%", marginBottom: 40}}>
          <div style={globals.paragraph}>
            In this group, {demo.count} participants have demographic data.
            Of those, {demo.gender_male} are male, {demo.gender_female} are female, {demo.gender_null} unknown.
            The average age is {Math.round(currentYear - demo.birth_year)}.
          </div>
          <span
            style={{
              width: globals.barChartWidth,
              position: "relative",
              left: 40
            }}>
            This Group ({groupVotesForOtherGroups["n-members"]})
          </span>
          <span
            style={{
              width: globals.barChartWidth,
              position: "relative",
              left: 40
            }}>
            All Others ({groupVotesForThisGroup["n-members"]})
          </span>
        </Flex>
      {drawGroupComments(groupVotesForThisGroup)}
      <h4>Metadata Comments</h4>
      {drawGroupMetadataComments()}
    </div>
  );
};

export default ParticipantGroup;
