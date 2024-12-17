import React from "react";
import * as globals from "./globals";

const getCurrentTimestamp = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}-${hours}${minutes}`;
};

const getDownloadFilename = (file, conversation) => {
  return `${getCurrentTimestamp()}-${conversation.conversation_id}-${file}.csv`;
};

const RawDataExport = ({ conversation, report_id }) => {
  const doShowDataLicenseTerms = ["pol.is", "preprod.pol.is", "localhost"].includes(
    window.location.hostname
  );

  return (
    <div
      style={{
        background: "#f1f1f1",
        padding: 10,
        borderRadius: 3,
        width: 960,
      }}
    >
      <p style={{ fontFamily: "monospace", fontSize: globals.fontSizes.medium }}>
        <strong>Raw Data Export (Anonymous)</strong>
      </p>
      <p style={{ fontFamily: "monospace", fontStyle: "italic" }}>
        {`The following data exports are anonymized. Participants are identifed by an integer representing the order in which they first voted. For a full description of files and columns, please see: `}
        <a href="https://compdemocracy.org/export/"> https://compdemocracy.org/export/ </a>
      </p>
      <p style={{ fontFamily: "monospace" }}>
        {`--------Summary: `}
        <a
          download={getDownloadFilename("summary", conversation)}
          href={`//${window.location.hostname}/api/v3/reportExport/${report_id}/summary.csv`}
          type="text/csv"
        >
          {getDownloadFilename("summary", conversation)}
        </a>
      </p>
      <p style={{ fontFamily: "monospace" }}>
        {`-------Comments: `}
        <a
          download={getDownloadFilename("comments", conversation)}
          href={`//${window.location.hostname}/api/v3/reportExport/${report_id}/comments.csv`}
          type="text/csv"
        >
          {getDownloadFilename("comments", conversation)}
        </a>
        {` (may take up to several minutes)`}
      </p>
      <p style={{ fontFamily: "monospace" }}>
        {`--Votes history: `}
        <a
          download={getDownloadFilename("votes", conversation)}
          href={`//${window.location.hostname}/api/v3/reportExport/${report_id}/votes.csv`}
          type="text/csv"
        >
          {getDownloadFilename("votes", conversation)}
        </a>
        {` (as event log)`}
      </p>
      <p style={{ fontFamily: "monospace" }}>
        {`---Votes matrix: `}
        <a
          download={getDownloadFilename("participant-votes", conversation)}
          href={`//${window.location.hostname}/api/v3/reportExport/${report_id}/participant-votes.csv`}
          type="text/csv"
        >
          {getDownloadFilename("participant-votes", conversation)}
        </a>
        {` (as comments x participants matrix)`}
      </p>
      <p style={{ fontFamily: "monospace" }}>
        {`Comment groups: `}
        <a
          download={getDownloadFilename("comment-groups", conversation)}
          href={`//${window.location.hostname}/api/v3/reportExport/${report_id}/comment-groups.csv`}
          type="text/csv"
        >
          {getDownloadFilename("comment-groups", conversation)}
        </a>
      </p>

      <div style={{ marginTop: "3em" }}>
        <p style={{ fontFamily: "monospace" }}>
          <strong>Public API endpoints (read only, Jupyter notebook friendly)</strong>
        </p>
        <p style={{ fontFamily: "monospace" }}>
          {`$ curl ${window.location.protocol}//${window.location.hostname}/api/v3/reportExport/${report_id}/summary.csv`}
        </p>
        <p style={{ fontFamily: "monospace" }}>
          {`$ curl ${window.location.protocol}//${window.location.hostname}/api/v3/reportExport/${report_id}/comments.csv`}
        </p>
        <p style={{ fontFamily: "monospace" }}>
          {`$ curl ${window.location.protocol}//${window.location.hostname}/api/v3/reportExport/${report_id}/votes.csv`}
        </p>
        <p style={{ fontFamily: "monospace" }}>
          {`$ curl ${window.location.protocol}//${window.location.hostname}/api/v3/reportExport/${report_id}/participant-votes.csv`}
        </p>
        <p style={{ fontFamily: "monospace" }}>
          {`$ curl ${window.location.protocol}//${window.location.hostname}/api/v3/reportExport/${report_id}/comment-groups.csv`}
        </p>
      </div>

      {doShowDataLicenseTerms && (
        <div style={{ marginTop: "3em" }}>
          <p style={{ fontFamily: "monospace" }}>
            <strong>Attribution of Polis Data</strong>
          </p>
          <p style={{ fontFamily: "monospace" }}>
            All Polis data is licensed under a Creative Commons Attribution 4.0 International
            license: https://creativecommons.org/licenses/by/4.0/
          </p>
          <p style={{ fontFamily: "monospace" }}>--------------- BEGIN STATEMENT ---------------</p>
          <p style={{ fontFamily: "monospace" }}>
            {`Data was gathered using the Polis software (see: compdemocracy.org/polis and github.com/compdemocracy/polis) and is sub-licensed
          under CC BY 4.0 with Attribution to The Computational Democracy Project. The data and more
          information about how the data was collected can be found at the following link: ${window.location.href}`}
          </p>
          <p style={{ fontFamily: "monospace" }}>--------------- END STATEMENT---------------</p>
          <p style={{ fontFamily: "monospace" }}>
            For further information on best practices for Attribution of CC 4.0 licensed content
            Please see:
            https://wiki.creativecommons.org/wiki/Best_practices_for_attribution#Title.2C_Author.2C_Source.2C_License
          </p>
        </div>
      )}
    </div>
  );
};

export default RawDataExport;
