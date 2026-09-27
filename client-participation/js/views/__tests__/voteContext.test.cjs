const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// Capture the actual exported methods. External framework/model/transport
// boundaries are explicit doubles; template/DOM/polling code is not invoked.
function fixture(initial = {}, options = {}) {
  const context = { remaining: 4, ...initial };
  const strings = {
    direction: options.direction || "ltr",
    anonPerson: "Anonymous",
    comments_remaining: "{{num_comments}} remaining",
    comments_remaining2: "Remaining: {{num_comments}}",
    showTranslationButton: "Translate",
    thirdPartyTranslationDisclaimer: "External translation"
  };
  const calls = [];
  const base = {
    context(...args) {
      calls.push({ receiver: this, args });
      return context;
    }
  };
  const dependencies = {
    "../eventBus": {},
    handlebones: { ModelView: { prototype: base, extend: (definition) => definition } },
    "../util/postMessageUtils": {},
    "../util/preloadHelper": {},
    "../templates/vote-view.handlebars": {},
    "../util/utils": {
      isIos: () => false,
      getAnonPicUrl: () => "/public-avatar",
      matchesUiLang: (lang) => lang === "fr",
      userCanSeeSubscribePrompt: () => options.canSubscribe !== false
    },
    "../strings": strings,
    jquery: {},
    lodash: {}
  };
  const module = { exports: {} },
    preload = { conversation: { importance_enabled: true }, firstPtpt: options.firstPtpt };
  const filename = path.join(__dirname, "../vote-view.js");
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      preload,
      userObject: { email: "public@example.invalid" },
      require(name) {
        assert.ok(Object.hasOwn(dependencies, name), name);
        return dependencies[name];
      }
    },
    { filename }
  );
  const model = { ...initial },
    updates = [],
    writes = [];
  const receiver = {
    isSubscribed: () => !!options.subscribed,
    votesByMe: { size: () => options.votes || 0 },
    model: {
      get: (key) => model[key],
      set: (value) => {
        updates.push(value);
        Object.assign(model, value);
      }
    },
    serverClient: { put_participants_extended: (value) => writes.push(value) }
  };
  return {
    definition: module.exports,
    receiver,
    context,
    calls,
    strings,
    preload,
    updates,
    writes,
    model,
    renderContext(...args) {
      return module.exports.context.apply(receiver, args);
    }
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test("context uses the current receiver/base result and preserves forwarded arguments", () => {
  const f = fixture();
  const argument = { public: true };
  assert.equal(f.renderContext(argument), f.context);
  assert.equal(f.calls[0].receiver, f.receiver);
  assert.equal(f.calls[0].args[0], argument);
  assert.equal(f.context.s, f.strings);
});

test("remaining-comment display caps only values over one hundred in both accessible labels", () => {
  for (const [remaining, label] of [
    [0, "0"],
    [1, "1"],
    [100, "100"],
    [101, "100+"]
  ]) {
    const f = fixture({ remaining });
    const result = f.renderContext();
    assert.equal(result.remainingString, `${label} remaining`);
    assert.equal(result.remainingStringScreenReader, `Remaining: ${label}`);
    assert.equal(result.remaining, remaining);
  }
});

test("subscription eligibility requires participation and the independent prompt policy", () => {
  for (const [options, expected] of [
    [{}, false],
    [{ votes: 1 }, true],
    [{ firstPtpt: {} }, true],
    [{ votes: 1, canSubscribe: false }, false]
  ]) {
    const f = fixture({}, options);
    assert.equal(f.renderContext().canSubscribe, expected);
  }
});

test("right-to-left layout changes margin and float while preserving configured button color", () => {
  const f = fixture({}, { direction: "rtl" });
  f.preload.conversation.style_btn = "#123456";
  const result = f.renderContext();
  assert.equal(result.pMarginStyle, "margin-right: 55px;");
  assert.equal(result.floatStyle, "float:left;");
  assert.equal(result.customBtnStyles, "background-color: #123456;");
});

test("anonymous context uses a fallback while explicit external identity uses supplied fields", () => {
  const anonymous = fixture().renderContext();
  assert.deepEqual(plain(anonymous.social), { name: "Anonymous", img: "/public-avatar", link: "", anon: true });
  const named = fixture({ social: { x_name: "Public name", x_profile_image_url: "/public-image" } }).renderContext();
  assert.deepEqual(plain(named.social), { name: "Public name", img: "/public-image" });
});

test("unofficial translation display retains original text and marks its source", () => {
  const translation = { txt: "Bonjour", lang: "fr", src: 0 };
  const f = fixture({ txt: "Hello", lang: "en", showTranslation: true, translations: [translation] });
  const result = f.renderContext();
  assert.equal(result.txt, "Hello");
  assert.equal(result.translationTxt, "Bonjour");
  assert.equal(result.translationSrc, 0);
  assert.equal(result.isUnofficialTranslation, true);
  assert.equal(result.showHideTranslationButton, true);
});

test("official translation selects a matching positive source and removes redundant toggles", () => {
  const f = fixture({
    txt: "Hello",
    lang: "en",
    showOfficialTranslation: true,
    showTranslation: true,
    translations: [
      { txt: "Machine", lang: "fr", src: 0 },
      { txt: "Wrong language", lang: "de", src: 1 },
      { txt: "Reviewed", lang: "fr", src: 2 }
    ]
  });
  const result = f.renderContext();
  assert.equal(result.txt, "Reviewed");
  assert.equal(result.lang, "fr");
  assert.equal(result.isUnofficialTranslation, false);
  assert.equal(result.showTranslation, false);
  assert.equal(result.showShowTranslationButton, false);
  assert.equal(result.showHideTranslationButton, false);
  assert.equal(Object.hasOwn(result, "translationTxt"), false);
});

test("matching original language hides redundant translated fields", () => {
  const result = fixture({
    txt: "Bonjour",
    lang: "fr",
    showTranslation: true,
    translations: [{ txt: "Other", lang: "fr", src: 0 }]
  }).renderContext();
  assert.equal(result.showTranslation, false);
  assert.equal(Object.hasOwn(result, "translationLang"), false);
  assert.equal(Object.hasOwn(result, "translationSrc"), false);
});

test("translation toggles prevent default before model state and participant preference writes", () => {
  const f = fixture(),
    events = [];
  f.receiver.model.set = (value) => events.push(["model", plain(value)]);
  f.receiver.serverClient.put_participants_extended = (value) => events.push(["server", plain(value)]);
  f.definition.showTranslationClicked.call(f.receiver, {
    preventDefault() {
      events.push(["prevent"]);
    }
  });
  f.definition.hideTranslationClicked.call(f.receiver, {
    preventDefault() {
      events.push(["prevent"]);
    }
  });
  assert.deepEqual(events, [
    ["prevent"],
    ["model", { showTranslation: true }],
    ["server", { show_translation_activated: true }],
    ["prevent"],
    ["model", { showTranslation: false }],
    ["server", { show_translation_activated: false }]
  ]);
});

test("moderation toggles are mutually exclusive and a repeated toggle clears the selection", () => {
  const f = fixture({ spamOn: false, otOn: true, importantOn: true });
  f.definition.spamToggle.call(f.receiver);
  assert.deepEqual(plain(f.model), { spamOn: true, otOn: false, importantOn: false });
  f.definition.spamToggle.call(f.receiver);
  assert.deepEqual(plain(f.model), { spamOn: false, otOn: false, importantOn: false });
  f.definition.otToggle.call(f.receiver);
  assert.deepEqual(plain(f.model), { spamOn: false, otOn: true, importantOn: false });
  f.definition.importantToggle.call(f.receiver);
  assert.deepEqual(plain(f.model), { spamOn: false, otOn: false, importantOn: true });
});

test("moderation context exposes no selection only when all flags are clear", () => {
  assert.equal(fixture({ spamOn: false, otOn: false, importantOn: false }).renderContext().noModSet, true);
  for (const key of ["spamOn", "otOn", "importantOn"])
    assert.equal(fixture({ [key]: true }).renderContext().noModSet, false);
});

test("failed model update prevents participant preference write and keeps the original error", () => {
  const f = fixture(),
    failure = new Error("public model failure");
  f.receiver.model.set = () => {
    throw failure;
  };
  assert.throws(
    () => f.definition.showTranslationClicked.call(f.receiver, { preventDefault() {} }),
    (error) => error === failure
  );
  assert.deepEqual(f.writes, []);
});
