import React from "react";
import Comment from "./participantGroupMetadataComment";
import Flex from "./flex";

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
    <Flex
      wrap="wrap"
      justifyContent="flex-start"
      styleOverrides={{
        maxWidth: 850
      }}>
       {
         _.keys(allTids).map((tid, i) => {
           return <Comment
             conversation={conversation}
             key={tid}
             index={i}
             comment={allCommentsKeyed[tid]}
             formatTid={formatTid}
             groupVotesForThisGroup={groupVotes}
             ptptCount={ptptCount}/>;
        })
      }
    </Flex>
  )
};

export default ParticipantGroupMetadataComments;
