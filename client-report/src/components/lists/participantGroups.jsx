// // Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useState, useEffect } from "react";
import Group from "./participantGroup.jsx";
import * as globals from "../globals.js";
import Metadata from "./metadata.jsx";

const ParticipantGroups = ({
  conversation,
  ptptCount,
  math,
  comments,
  style,
  voteColors,
  formatTid,
  demographics,
  groupNames,
  badTids,
  repfulAgreeTidsByGroup,
  repfulDisageeTidsByGroup,
  report,
}) => {
  const [isLoading, setIsLoading] = useState(true);
  const [groups, setGroups] = useState([]);

  useEffect(() => {
    if (!conversation || !math || !comments) return;

    const processGroups = () => {
      const processedGroups = Object.keys(math["repness"]).map((gid) => { // Use Object.keys and map
        gid = Number(gid);

        let otherGroupVotes = {
          votes: [],
          "n-members": 0,
        };

        const MAX_CLUSTERS = 50;
        const temp = math["group-votes"];

        for (let ogid = 0; ogid < MAX_CLUSTERS; ogid++) {
          if (ogid === gid || !temp[ogid]) {
            continue;
          }
          otherGroupVotes["n-members"] += temp[ogid]["n-members"];
          const commentVotes = temp[ogid].votes;

          Object.keys(commentVotes || {}).forEach((tid) => { // Use Object.keys and forEach
            tid = Number(tid);
            const voteObj = commentVotes[tid];
            if (voteObj) {
              if (!otherGroupVotes.votes[tid]) {
                otherGroupVotes.votes[tid] = { A: 0, D: 0, S: 0 };
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
            comments={comments}
            gid={gid}
            conversation={conversation}
            demographicsForGroup={demographics[gid]}
            groupComments={math["repness"][gid]} // Access directly
            groupName={groupNames[gid]}
            groupVotesForThisGroup={math["group-votes"][gid]}
            groupVotesForOtherGroups={otherGroupVotes}
            formatTid={formatTid}
            ptptCount={ptptCount}
            groupNames={groupNames}
            badTids={badTids}
            repfulAgreeTidsByGroup={repfulAgreeTidsByGroup}
            repfulDisageeTidsByGroup={repfulDisageeTidsByGroup}
            math={math}
            report={report}
            voteColors={voteColors}
          />
        );
      });

      setGroups(processedGroups);
      setIsLoading(false);
    };

    processGroups();
  }, [conversation, math, comments]);

  const styles = {
    base: {},
    ...style,
  };

  return (
    <div style={styles}>
      <div>
        <p style={globals.primaryHeading}> Opinion Groups </p>
        <p style={globals.paragraph}>
          Across {ptptCount} total participants, {math && Object.keys(math["group-votes"])?.length}{" "}
          opinion groups emerged. There are two factors that define an opinion
          group. First, each opinion group is made up of a number of participants
          who tended to vote similarly on multiple statements. Second, each group
          of participants who voted similarly will have also voted distinctly
          differently from other groups.
        </p>
        <Metadata
          math={math}
          comments={comments}
          conversation={conversation}
          ptptCount={ptptCount}
          voteColors={voteColors}
          formatTid={formatTid}
        />
        {isLoading ? (
          <div>Loading Groups</div>
        ) : (
          groups
        )}
      </div>
    </div>
  );
};

export default ParticipantGroups;