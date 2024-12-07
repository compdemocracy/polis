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
      {/* Rest of the export links and curl commands */}
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
      {/* Add the rest of the export links here... */}

      <div style={{ marginTop: "3em" }}>
        <p style={{ fontFamily: "monospace" }}>
          <strong>Public API endpoints (read only, Jupyter notebook friendly)</strong>
        </p>
        <p style={{ fontFamily: "monospace" }}>
          {`$ curl ${window.location.protocol}//${window.location.hostname}/api/v3/reportExport/${report_id}/summary.csv`}
        </p>
        {/* Add the rest of the curl commands here... */}
      </div>

      {doShowDataLicenseTerms && (
        <div style={{ marginTop: "3em" }}>
          <p style={{ fontFamily: "monospace" }}>
            <strong>Attribution of Polis Data</strong>
          </p>
          {/* Add the rest of the license terms here... */}
        </div>
      )}
    </div>
  );
};

export default RawDataExport;
