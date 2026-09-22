import React from "react";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import * as d3 from "d3";
import { emptyMath } from "../testFixtures/emptyMath";
import Majority from "./lists/majorityStrict";
import Groups from "./lists/participantGroups";
import Graph from "./participantsGraph/participantsGraph";
import TopicMap from "./topicMapNarrativeReport";
import AllScatter from "./topicStats/visualizations/AllCommentsScatterplot";
import TopicScatter from "./topicStats/visualizations/TopicOverviewScatterplot";
import { canGenerateCollectiveStatement } from "../util/consensusThreshold";
import { enrichMathWithNormalizedConsensus } from "../util/normalizeConsensus";
// Real React, graph utilities and D3; child network/large rendering boundaries doubled.
jest.mock("./lists/commentList", () => (props) => (
  <output data-testid="comments">{JSON.stringify(props.tidsToRender)}</output>
));
jest.mock("./lists/metadata", () => () => null);
jest.mock("./topicsVizReport/TopicsVizReport", () => () => null);
jest.mock("./topicReport/TopicReport", () => () => null);
jest.mock("./topicScatterplot/TopicScatterplot", () => () => <div data-testid="scatter" />);
const props = {
  conversation: { conversation_id: "public-fixture" },
  comments: [
    {
      tid: 0,
      pid: 0,
      txt: "Public fixture statement",
      count: 0,
      agree_count: 0,
      disagree_count: 0,
      pass_count: 0,
    },
  ],
  ptptCount: 0,
  ptptCountTotal: 0,
  formatTid: String,
  voteColors: { agree: "green", disagree: "red", pass: "gray" },
  badTids: {},
  groupNames: {},
  report: {},
};
beforeAll(() => {
  window.d3 = d3;
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());
afterEach(cleanup);
test.each([false, true])("majority renders zero consensus, legacy=%s", (legacy) => {
  const math = emptyMath(legacy);
  render(<Majority {...props} math={math} consensus={math.consensus} />);
  expect(screen.getByTestId("comments")).toHaveTextContent("[]");
});
test.each([false, true])("groups render zero groups, legacy=%s", (legacy) => {
  render(<Groups {...props} math={emptyMath(legacy)} />);
  expect(
    screen.getByText(/Across 0 total participants, 0 opinion groups emerged/)
  ).toBeInTheDocument();
});
test.each([false, true])("participant graph renders with empty clusters, legacy=%s", (legacy) => {
  const { container } = render(<Graph {...props} math={emptyMath(legacy)} />);
  expect(screen.getByRole("button", { name: "Axes" })).toBeInTheDocument();
  expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
});
test.each([false, true])("topic map narrative renders zero groups, legacy=%s", (legacy) => {
  render(<TopicMap {...props} math={emptyMath(legacy)} globals={{}} computeVoteTotal={() => 0} />);
  expect(screen.getByText("Opinion Groups").nextSibling).toHaveTextContent("0");
});
test.each([AllScatter, TopicScatter])("empty consensus hides scatterplot section", (Component) => {
  const { container } = render(
    <Component {...props} math={emptyMath()} topics={{}} statsData={{}} />
  );
  expect(container).toBeEmptyDOMElement();
});
test("no groups cannot satisfy collective statement participation vacuously", () => {
  const math = emptyMath();
  math["group-aware-consensus"] = { 0: 1, 1: 1, 2: 1 };
  expect(canGenerateCollectiveStatement([0, 1, 2], math).canGenerate).toBe(false);
});
test("empty votes do not create a normalized map that masks raw consensus", () => {
  const math = emptyMath();
  math["group-aware-consensus"] = { 0: 0.9 };
  expect(enrichMathWithNormalizedConsensus(math)).not.toHaveProperty("group-consensus-normalized");
});
test("populated participation remains eligible", () => {
  const math = emptyMath();
  math["group-aware-consensus"] = { 0: 1, 1: 1, 2: 1 };
  math["group-votes"] = {
    0: { "n-members": 10, votes: { 0: { A: 10 }, 1: { A: 10 }, 2: { A: 10 } } },
  };
  expect(canGenerateCollectiveStatement([0, 1, 2], math).canGenerate).toBe(true);
});

import Beeswarm from "./topicStats/visualizations/TopicBeeswarm";
import Layer from "./topicStats/LayerDistributionModal";
import AllComments from "./lists/allCommentsModeratedIn";
import TopicPage from "./topicPage/TopicPage";
import NarrativeOverview from "./narrativeOverview";
import net from "../util/net";
jest.mock("../util/net", () => ({ polisGet: jest.fn() }));
test.each([false, true])("empty beeswarm reports no data, legacy=%s", (legacy) => {
  const { container } = render(<Beeswarm {...props} commentTids={[0]} math={emptyMath(legacy)} />);
  expect(screen.getByText("No data available for visualization")).toBeInTheDocument();
  expect(container.querySelector("svg")).toBeNull();
});
test("layer plot is removed when populated consensus becomes empty", () => {
  window.Plotly = { newPlot: jest.fn() };
  const math = emptyMath();
  math["group-aware-consensus"] = { 0: 0.9 };
  const layerProps = {
    isOpen: true,
    onClose: () => {},
    topics: { 0: { topic_key: "t", topic_name: "T" } },
    statsData: { t: { comment_tids: [0] } },
    comments: [{ ...props.comments[0], agree_count: 6 }],
  };
  const { container, rerender } = render(<Layer {...layerProps} math={math} />);
  expect(window.Plotly.newPlot).toHaveBeenCalledTimes(1);
  rerender(<Layer {...layerProps} math={emptyMath()} />);
  expect(screen.getByText("No data to display")).toBeInTheDocument();
  expect(container.querySelector("#layer-distribution-plot")).toBeNull();
  expect(window.Plotly.newPlot).toHaveBeenCalledTimes(1);
});
test("consensus sorting puts scored comments before absent scores", () => {
  render(
    <AllComments
      {...props}
      math={emptyMath()}
      comments={[
        { tid: 0 },
        { tid: 1, "group-aware-consensus": 0.8 },
        { tid: 2, "group-aware-consensus": 0.5 },
      ]}
    />
  );
  fireEvent.change(screen.getByLabelText("Sort by:"), { target: { value: "consensus" } });
  expect(screen.getByTestId("comments")).toHaveTextContent("[1,2,0]");
});
test("topic page reports empty visualization for explicit empty consensus", async () => {
  net.polisGet.mockImplementation(async (url) => {
    if (url.endsWith("/delphi"))
      return {
        status: "success",
        runs: { a: { topics_by_layer: { 0: { 0: { topic_key: "t", topic_name: "Public fixture" } } } } },
      };
    if (url.endsWith("/topicStats"))
      return { status: "success", stats: { t: { comment_tids: [0] } } };
    return { status: "success", statements: [] };
  });
  render(<TopicPage {...props} report_id="public-fixture" topic_key="t" math={emptyMath()} />);
  await waitFor(() =>
    expect(screen.getAllByText("No data available for visualization").length).toBeGreaterThan(0)
  );
  expect(screen.queryByTestId("scatter")).not.toBeInTheDocument();
});
test("narrative overview accepts omitted empty fields", () => {
  const { container } = render(
    <NarrativeOverview
      {...props}
      math={emptyMath(true)}
      computedStats={{ votesPerVoterAvg: 0, commentsPerCommenterAvg: 0 }}
      computeVoteTotal={() => 0}
      globals={{}}
    />
  );
  expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
});
