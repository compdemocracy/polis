const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const babel = require("@babel/core");
const React = require("react");

// Load the entire entry and its real local imports. Only the external ReactDOM
// root boundary is doubled: these tests do not mount a DOM or exercise geometry.
function entry(createRoot) {
  const window = {};
  const document = { getElementById: () => ({}) };
  const getComputedStyle = () => ({ width: "1000px" });
  const modules = new Map();
  function load(filename) {
    filename = require.resolve(filename);
    if (filename.includes(`${path.sep}3rdparty${path.sep}`)) return require(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const { code } = babel.transformSync(fs.readFileSync(filename, "utf8"), {
      filename,
      babelrc: false,
      configFile: false,
      presets: [
        [require.resolve("@babel/preset-env"), { targets: { node: "current" }, modules: "commonjs" }],
        [require.resolve("@babel/preset-react"), { runtime: "classic" }]
      ]
    });
    function localRequire(name) {
      if (name === "react-dom/client") return { createRoot };
      return name.startsWith(".") ? load(path.resolve(path.dirname(filename), name)) : require(name);
    }
    vm.runInNewContext(
      code,
      { require: localRequire, module, exports: module.exports, window, document, getComputedStyle },
      { filename }
    );
    return module.exports;
  }
  load(path.resolve(__dirname, "../vis2.js"));
  return {
    window,
    Graph: load(path.resolve(__dirname, "../components/graph.js")).default,
    ExploreTid: load(path.resolve(__dirname, "../components/exploreTid.js")).default,
    graphUtil: load(path.resolve(__dirname, "../util/graphUtil.js")).default
  };
}

const emptyMath = require("../../test-fixtures/emptyMath.cjs");
const { renderToStaticMarkup } = require("react-dom/server");
function descendants(node) {
  if (!React.isValidElement(node)) return [];
  return [node, ...React.Children.toArray(node.props.children).flatMap(descendants)];
}
for (const legacy of [false, true])
  test(`graph render does not consult removed firstMath; legacy=${legacy}`, () => {
    const { Graph } = entry(() => ({ render() {} }));
    const graph = new Graph({ math: emptyMath(legacy), comments: [], tidsToShow: [] });
    const nodes = descendants(graph.render()).filter((n) => Object.hasOwn(n.props, "groups"));
    assert.equal(nodes.length, 2);
    for (const n of nodes) assert.deepEqual(Object.keys(n.props.groups), []);
  });
for (const legacy of [false, true])
  for (const selection of [0, "majority"])
    test(`unavailable curation stats render no data sentence; legacy=${legacy}, selection=${selection}`, () => {
      const { ExploreTid } = entry(() => ({ render() {} }));
      const result = renderToStaticMarkup(
        React.createElement(ExploreTid, {
          math: emptyMath(legacy),
          selectedComment: { tid: 0, txt: "Synthetic" },
          selectedTidCuration: selection,
          Strings: {}
        })
      );
      assert.ok(result.includes("Synthetic"));
      assert.ok(!/NaN|Infinity|undefined/.test(result));
    });
test("legacy omissions do not break graph data construction", () => {
  const { graphUtil } = entry(() => ({ render() {} }));
  const result = graphUtil([], emptyMath(true), {}, []);
  assert.deepEqual(Array.from(result.groupCentroids), []);
});

test("populated graph forwards existing group vote objects unchanged", () => {
  const { Graph } = entry(() => ({ render() {} }));
  const math = emptyMath();
  math["group-votes"] = { 0: { "n-members": 5, votes: {} } };
  const graph = new Graph({ math, comments: [], tidsToShow: [] });
  const nodes = descendants(graph.render()).filter((n) => Object.hasOwn(n.props, "groups"));
  assert.equal(nodes.length, 2);
  for (const n of nodes) assert.equal(n.props.groups, math["group-votes"]);
});
test("populated majority statement preserves its percentage", () => {
  const { ExploreTid } = entry(() => ({ render() {} }));
  const math = emptyMath();
  math.consensus.agree = [{ tid: 0, "n-success": 8, "n-trials": 10 }];
  const result = renderToStaticMarkup(
    React.createElement(ExploreTid, {
      math,
      selectedComment: { tid: 0, txt: "Synthetic" },
      selectedTidCuration: "majority",
      Strings: { pctAgreedLong: "{{pct}} percent agreed on {{comment_id}}" }
    })
  );
  assert.ok(result.includes("80 percent agreed on 0"));
});
