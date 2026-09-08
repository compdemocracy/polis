import React from "react";
import Heading from "./framework/heading.jsx";
import Footer from "./framework/Footer.jsx";
import RawDataExport from "./RawDataExport.jsx";
import TopicsVizReport from "./topicsVizReport/TopicsVizReport.jsx";
import TopicReport from "./topicReport/TopicReport.jsx";

export default ({ conversation, report_id, ptptCountTotal, math, computeVoteTotal, globals, comments, formatTid, voteColors }) => (
  <div style={{ margin: "0px 10px", maxWidth: "1200px", padding: "20px" }} data-testid="reports-overview">
    <Heading conversation={conversation} />
    <div
      style={{
        marginTop: 40,
      }}
    >
      
      <div style={{ marginBottom: 20}}>
        <div>
          <p style={globals.primaryHeading}>Overview</p>
          <p style={globals.paragraph}>
            Pol.is is a real-time survey system that helps identify the different ways a large group
            of people think about a divisive or complicated topic. Here's a basic breakdown of some
            terms you'll need to know in order to understand this report.
          </p>
          <p style={globals.paragraph}>
            <strong>Participants:</strong> These are the people who participated in the conversation
            by voting and writing statements. Based on how they voted, each participant is sorted into
            an opinion group.
          </p>
          <p style={globals.paragraph}>
            <strong>Statements:</strong> Participants may submit statements for other participants to
            vote on. Statements are assigned a number in the order they're submitted.
          </p>
          <p style={globals.paragraph}>
            <strong>Opinion groups:</strong> Groups are made of participants who voted similarly to
            each other, and differently from the other groups.
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
      </div>
      <section style={{ maxWidth: 1200, display: "flex", justifyContent: "space-between", gap: "1rem" }}>
        <div style={{ flex: 1, minWidth: "200px", border: "1px solid #333", padding: "1rem", textAlign: "center"}}>
          <h3>Participants</h3>
          <p style={{ fontFamily: "'VT323', monospace", fontSize: "2.5rem", margin: 0}}>{ptptCountTotal}</p>
        </div>
        <div style={{ flex: 1, minWidth: "200px", border: "1px solid #333", padding: "1rem", textAlign: "center"}}>
          <h3>Comments</h3>
          <p style={{ fontFamily: "'VT323', monospace", fontSize: "2.5rem", margin: 0}}>{math["n-cmts"]}</p>
        </div>
        <div style={{ flex: 1, minWidth: "200px", border: "1px solid #333", padding: "1rem", textAlign: "center"}}>
          <h3>Votes</h3>
          <p style={{ fontFamily: "'VT323', monospace", fontSize: "2.5rem", margin: 0}}>{computeVoteTotal(math["user-vote-counts"])}</p>
        </div>
        <div style={{ flex: 1, minWidth: "200px", border: "1px solid #333", padding: "1rem", textAlign: "center"}}>
          <h3>Opinion Groups</h3>
          <p style={{ fontFamily: "'VT323', monospace", fontSize: "2.5rem", margin: 0}}>{math["group-clusters"].length}</p>
        </div>
      </section>
      <TopicsVizReport report_id={report_id} />
      <TopicReport report_id={report_id} math={math} comments={comments} conversation={conversation} ptptCount={ptptCountTotal} formatTid={formatTid} voteColors={voteColors} />
      <div style={{ marginTop: 20 }}>
        <RawDataExport conversation={conversation} report_id={report_id} />
      </div>
      <Footer />
    </div>
  </div>
);