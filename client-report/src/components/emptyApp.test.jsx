import React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { emptyMath } from "../testFixtures/emptyMath";
import net from "../util/net";
jest.mock("../util/net", () => ({ polisGet: jest.fn() }));
jest.mock("react-oidc-context", () => ({
  useAuth: () => ({ isAuthenticated: false, isLoading: false, user: null }),
}));
jest.mock("./globals", () => ({
  enableMatrix: false,
  brandColors: { agree: "green", disagree: "red", pass: "gray" },
}));
jest.mock("./overview", () => (props) => (
  <output data-testid="average">{props.computedStats.votesPerVoterAvg}</output>
));
jest.mock("./framework/heading.jsx", () => () => null);
jest.mock("./framework/Footer.jsx", () => () => null);
jest.mock("./narrativeOverview.jsx", () => () => null);
jest.mock("./lists/majorityStrict.jsx", () => () => null);
jest.mock("./lists/uncertainty.jsx", () => () => null);
jest.mock("./lists/uncertaintyNarrative.jsx", () => () => null);
jest.mock("./lists/groupsNarrative.jsx", () => () => null);
jest.mock("./lists/allCommentsModeratedIn.jsx", () => () => null);
jest.mock("./lists/participantGroups.jsx", () => () => null);
jest.mock("./participantsGraph/participantsGraph.jsx", () => () => null);
jest.mock("./beeswarm/beeswarm.jsx", () => () => null);
jest.mock("./controls/controls.jsx", () => () => null);
jest.mock("./lists/consensusNarrative.jsx", () => () => null);
jest.mock("./RawDataExport.jsx", () => () => null);
jest.mock("./lists/topicNarrative.jsx", () => () => null);
jest.mock("./commentsReport/CommentsReport.jsx", () => () => null);
jest.mock("./topicReport/TopicReport.jsx", () => () => null);
jest.mock("./exportReport/ExportReport.jsx", () => () => null);
jest.mock("./topicsVizReport/TopicsVizReport.jsx", () => () => null);
jest.mock("./topicMapNarrativeReport.jsx", () => () => null);
jest.mock("./topicStats/TopicStats.jsx", () => () => null);
jest.mock("./topicPage/TopicPage.jsx", () => () => null);
jest.mock("./collectiveStatementsReport/CollectiveStatementsReport.jsx", () => () => null);
window.history.replaceState({}, "", "/report/synthetic");
const App = require("./app").default;
let math;
beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(window, "setInterval").mockImplementation(() => 1);
  net.polisGet.mockImplementation(async (url) => {
    if (url.endsWith("/reports"))
      return [{ report_id: "synthetic", conversation_id: "synthetic", mod_level: -2 }];
    if (url.endsWith("/pca2")) return math;
    if (url.endsWith("/conversations"))
      return { conversation_id: "synthetic", participant_count: 0 };
    if (url.endsWith("/comments"))
      return [{ tid: 0, pid: 0, txt: "Synthetic", count: 0, pass_count: 0 }];
    if (url.endsWith("/ptptois")) return [];
    return {};
  });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});
test.each(["python", "legacy", "missing"])(
  "report load completes with finite average: %s",
  async (kind) => {
    math = kind === "missing" ? null : emptyMath(kind === "legacy");
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("average")).toHaveTextContent("0"));
    expect(screen.queryByText(/Error Loading|Loading \.\.\./)).not.toBeInTheDocument();
  }
);
