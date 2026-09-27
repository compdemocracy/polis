const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const babel = require("@babel/core");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

// Transform the original modules with the package's declared Babel presets.
// React, ReactDOM, lodash and local components are real; no module mocks.
const modules = new Map();
function load(filename) {
  filename = require.resolve(filename);
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
  const localRequire = (name) =>
    name.startsWith(".") ? load(path.resolve(path.dirname(filename), name)) : require(name);
  vm.runInThisContext(`(function(require, module, exports) {\n${code}\n})`, { filename })(
    localRequire,
    module,
    module.exports
  );
  return module.exports;
}

const Header = load(path.resolve(__dirname, "../header.js")).default;
const Curate = load(path.resolve(__dirname, "../curate.js")).default;
const TidCarousel = load(path.resolve(__dirname, "../tidCarousel.js")).default;

// Visit actual render output to invoke its callbacks. This is not DOM mounting,
// reconciliation or React state scheduling; static rendering is checked below.
function elements(element, type) {
  if (!React.isValidElement(element)) return [];
  if (typeof element.type === "function") {
    const rendered =
      element.type.prototype instanceof React.Component
        ? new element.type(element.props).render()
        : element.type(element.props);
    return elements(rendered, type);
  }
  return [
    ...(element.type === type ? [element] : []),
    ...React.Children.toArray(element.props.children).flatMap((child) => elements(child, type))
  ];
}

const Strings = Object.freeze({
  majorityOpinion: "Public majority",
  group_123: "Public groups",
  comment_123: "Public comments"
});
function curate(overrides = {}) {
  return React.createElement(Curate, {
    Strings,
    math: { "group-votes": [{ id: 2 }, { id: 0 }] },
    selectedTidCuration: null,
    handleCurateButtonClick: () => assert.fail("render must not dispatch"),
    ...overrides
  });
}
function carousel(overrides = {}) {
  return React.createElement(TidCarousel, {
    Strings,
    selectedTidCuration: "majority",
    selectedComment: null,
    commentsToShow: [{ tid: 0 }, { tid: 5 }],
    handleCommentClick: () => () => assert.fail("render must not click"),
    ...overrides
  });
}

test("embedded nonowner renders neither public branding nor management navigation", () => {
  const html = renderToStaticMarkup(React.createElement(Header, { is_embedded: true, is_owner: false }));
  assert.doesNotMatch(html, /<svg|<a /);
});

test("nonembedded nonowner gets the real branding without a management link", () => {
  const html = renderToStaticMarkup(React.createElement(Header, { is_embedded: false, is_owner: false }));
  assert.match(html, /<svg/);
  assert.match(html, /p\./);
  assert.doesNotMatch(html, /<a /);
});

test("owner navigation binds the supplied conversation even when embedded", () => {
  const element = React.createElement(Header, {
    is_embedded: true,
    is_owner: true,
    conversation_id: "public-conversation"
  });
  const links = elements(element, "a");
  assert.equal(links.length, 1);
  assert.equal(links[0].props.href, "/m/public-conversation");
  assert.equal(links[0].props.target, "_blank");
  assert.equal(links[0].props.rel, "noreferrer");
  assert.match(renderToStaticMarkup(element), /href="\/m\/public-conversation"/);
});

test("curation renders input group order and dispatches actual IDs, including zero", () => {
  const received = [];
  const element = curate({ handleCurateButtonClick: (id) => received.push(id) });
  const buttons = elements(element, "button");
  assert.deepEqual(
    buttons.map((button) => button.props.children),
    ["Public majority", "C", "A"]
  );
  assert.deepEqual(received, []);
  buttons.forEach((button) => button.props.onClick());
  assert.deepEqual(received, ["majority", 2, 0]);
  assert.match(renderToStaticMarkup(element), /Public groups/);
});

test("empty group curation still offers the majority action", () => {
  const received = [];
  const element = curate({ math: { "group-votes": [] }, handleCurateButtonClick: (id) => received.push(id) });
  const buttons = elements(element, "button");
  assert.equal(buttons.length, 1);
  buttons[0].props.onClick();
  assert.deepEqual(received, ["majority"]);
});

test("a selected zero group is visually distinguished without selecting majority", () => {
  const buttons = elements(curate({ selectedTidCuration: 0 }), "button");
  assert.equal(buttons[0].props.style.backgroundColor, buttons[1].props.style.backgroundColor);
  assert.notEqual(buttons[2].props.style.backgroundColor, buttons[0].props.style.backgroundColor);
  assert.ok(buttons[2].props.style.fontWeight > buttons[0].props.style.fontWeight);
});

test("null curation hides the carousel and does not bind comment actions", () => {
  const element = carousel({
    selectedTidCuration: null,
    handleCommentClick: () => assert.fail("hidden comment action bound")
  });
  assert.equal(renderToStaticMarkup(element), "");
  assert.deepEqual(elements(element, "button"), []);
});

test("carousel binds only its first ten visible comments without dispatching", () => {
  const comments = Array.from({ length: 12 }, (_, tid) => Object.freeze({ tid }));
  const bound = [];
  const clicked = [];
  const element = carousel({
    commentsToShow: Object.freeze(comments),
    handleCommentClick: (comment) => {
      bound.push(comment);
      return () => clicked.push(comment);
    }
  });
  const buttons = elements(element, "button");
  assert.equal(buttons.length, 10);
  assert.deepEqual(bound, comments.slice(0, 10));
  assert.deepEqual(clicked, []);
  buttons[0].props.onClick();
  buttons[9].props.onClick();
  assert.equal(clicked[0], comments[0]);
  assert.equal(clicked[1], comments[9]);
});

test("selected comment zero is emphasized while labels remain actual IDs", () => {
  const element = carousel({ selectedTidCuration: 0, selectedComment: { tid: 0 } });
  const buttons = elements(element, "button");
  assert.deepEqual(
    buttons.map((button) => button.props.children),
    [0, 5]
  );
  assert.ok(buttons[0].props.style.fontWeight > buttons[1].props.style.fontWeight);
  assert.notEqual(buttons[0].props.style.border, buttons[1].props.style.border);
  assert.match(renderToStaticMarkup(element), /Public comments/);
});

test("empty comment input renders no comment actions and preserves localized label", () => {
  const element = carousel({ commentsToShow: [] });
  assert.deepEqual(elements(element, "button"), []);
  assert.match(renderToStaticMarkup(element), /Public comments/);
});
