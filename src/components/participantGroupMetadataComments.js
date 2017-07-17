import React from "react";
import Flex from "./flex";

const ParticipantGroupMetadataComment = ({comment, ptptCount, groupVotesForThisGroup, index}) => {

    const percentAgreed = Math.floor(groupVotesForThisGroup.votes[comment.tid].A / groupVotesForThisGroup.votes[comment.tid].S * 100);

    return (
      <Flex
        direction="row"
        justifyContent="flex-start"
        alignItems="center"
        styleOverrides={{
          padding: "6px 10px",
          borderBottom: "1px solid rgb(200,200,200)",
        }}>
        <span style={{
            fontSize: 12,
            width: 300,
            marginRight: 20,
            display: "inline-block",
            textAlign: "auto ",
          }}>
          { comment.txt }
        </span>
        <span style={{
            fontSize: 12,
            width: 70,
            marginRight: 20,
            display: "inline-block",
            textAlign: "auto ",
          }}> {groupVotesForThisGroup.votes[comment.tid].S} </span>
        <span style={{
            fontSize: 12,
            width: 70,
            marginRight: 20,
            display: "inline-block",
            textAlign: "auto ",
          }}> {groupVotesForThisGroup.votes[comment.tid].A} </span>
        <span style={{
            fontSize: 12,
            width: 70,
            marginRight: 20,
            display: "inline-block",
            textAlign: "auto ",
            fontWeight: percentAgreed >= 50 ? 700 : 300,
          }}> {percentAgreed} </span>
      </Flex>
    );
}

const ParticipantGroupMetadataComments = ({allComments, conversation, formatTid, ptptCount, demographicsForGroup}) => {

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

  return (
    <div>
      <div style={{marginBottom: 1, borderBottom: "2px solid black"}}>
        <span style={{
          width: 300,
          marginRight: 30, /* the 10 in padding from the cells */
          display: "inline-block",
          fontWeight: 700,
          fontSize: 14,
          textTransform: "uppercase"
        }}>metadata comment</span>
        <span style={{
          width: 70,
          marginRight: 20,
          display: "inline-block",
          fontWeight: 700,
          fontSize: 14,
          textTransform: "uppercase"
        }}>
          # VOTED
        </span>
        <span style={{
          width: 70,
          marginRight: 20,
          display: "inline-block",
          fontWeight: 700,
          fontSize: 14,
          textTransform: "uppercase"
        }}>
          # AGREED
        </span>
        <span style={{
          width: 70,
          marginRight: 20,
          display: "inline-block",
          fontWeight: 700,
          fontSize: 14,
          textTransform: "uppercase"
        }}>
          % AGREED
        </span>
      </div>
       {
         _.keys(allTids).map((tid, i) => {
           return <ParticipantGroupMetadataComment
             conversation={conversation}
             key={tid}
             index={i}
             comment={allCommentsKeyed[tid]}
             formatTid={formatTid}
             groupVotesForThisGroup={groupVotes}
             ptptCount={ptptCount}/>;
        })
      }
    </div>
  )
};

export default ParticipantGroupMetadataComments;
