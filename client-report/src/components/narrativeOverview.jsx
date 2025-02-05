// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import * as globals from "./globals";

const computeVoteTotal = (users) => {
  let voteTotal = 0;

  for (const count in users) {
    voteTotal += users[count];
  }

  return voteTotal;
};

const Number = ({ number, label }) => (
  <div style={{ marginLeft: "10px", marginRight: "10px" }}>
    <p style={globals.overviewNumber}>{number.toLocaleString()}</p>
    <p style={globals.overviewLabel}>{label}</p>
  </div>
);

const Overview = ({ conversation, ptptCount, ptptCountTotal, math, computedStats }) => {
  return (
    <div>
      <div>
        <p style={globals.primaryHeading}>Narrative Report — Beta Version</p>
        <p style={globals.paragraph}>
          You're seeing a beta version of Polis' new narrative report—generated with the help of
          Large Language Models (LLMs). We are currently crowdsourcing evaluations of this report
          with the help of our user community—people like you! Thank you for participating in these
          early evaluations.
        </p>
        <p style={globals.paragraph}>
          This report has been designed to address a critical bottleneck in Polis conversations:
          human facilitators spend countless hours turning Polis results into accessible reports for
          both participants and decision-makers. Our goal is to accelerate and enhance, not replace,
          human report writing. The intention is to get you 95-98% of the way to a final,
          deliverable report—in a fraction of the time it would take manually. We aim to improve
          both quality and speed through ongoing iteration.
        </p>
        <p style={globals.secondaryHeading}>
          <strong>Generating a Polis Narrative Report</strong>
        </p>

        <p style={globals.paragraph}>
          To generate a narrative report, you can currently choose between Gemini and Claude, with
          many more options coming soon. You can use the same link to access the report throughout
          the conversation. A new intermediary report is recomputed every hour, and a final report
          will be generated once the conversation is closed. To keep a record of intermediary
          reports, please save them as PDFs.
        </p>

        <p style={globals.paragraph}>
          We advise against sharing intermediary narrative reports with the broader public, as it
          can change significantly throughout the conversation and may contain errors. Once the
          conversation is complete, you can review the final report and share it as is or create a
          custom version for wider distribution.
        </p>
        <p style={globals.secondaryHeading}>
          <strong>Reviewing the Final Narrative Report</strong>
        </p>
        <p style={globals.paragraph}>
          The report will very likely contain errors. Each clause in the report should be
          accompanied by citations, drawn from statements submitted by participants. Please review
          each clause against the cited statements and flag the following:
          <ol>
            <li>Clauses that do not have accompanying citations</li>
            <li>Clauses that misrepresent the cited statements</li>
            <li>Redundant clauses that are not helpful</li>
            <li>Statistical or numeric issues with the summary</li>
            <li>Narrative issues, including issues with flow, organization, and story cohesion</li>
          </ol>
          For quality control purposes, you will not be able to add new clauses to the Polis
          narrative you will not be able to add new clauses to the Polis narrative report. However,
          you are welcome to add or remove content when generating your own custom reports.
        </p>

        <p style={globals.paragraph}>
          {conversation && conversation.ownername
            ? "This pol.is conversation was run by " + conversation.ownername + ". "
            : null}
          {conversation && conversation.topic
            ? "The topic was '" + conversation.topic + "'. "
            : null}
        </p>
      </div>

      <div style={{ maxWidth: 1200, display: "flex", justifyContent: "space-between" }}>
        <Number number={ptptCountTotal} label={"people voted"} />
        <Number number={ptptCount} label={"people grouped"} />

        <Number number={computeVoteTotal(math["user-vote-counts"])} label={"votes were cast"} />
        {/* Leaving this out for now until we get smarter conversationStats */}
        {/* <Number number={comments.length} label={"people submitted statements"} /> */}
        <Number number={math["n-cmts"]} label={"statements were submitted"} />
        <Number
          number={computedStats.votesPerVoterAvg.toFixed(2)}
          label={"votes per voter on average"}
        />
        <Number
          number={computedStats.commentsPerCommenterAvg.toFixed(2)}
          label={"statements per author on average"}
        />
      </div>
    </div>
  );
};

export default Overview;
