const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// Actual dispatcher and dictionaries, isolated per import. Preload/language and
// shallow extension are boundary doubles; no browser or lodash lifecycle claim.
function fixture(header = "", override = "") {
  let callback;
  const dictionaries = new Map();
  const module = { exports: {} };
  const preload = { acceptLanguage: header };
  const filename = path.join(__dirname, "../strings.js");
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      window: {},
      preload,
      require(name) {
        if (name === "./util/preloadHelper")
          return {
            acceptLanguagePromise: {
              then(fn) {
                callback = fn;
              }
            }
          };
        if (name === "./util/utils") return { uiLanguage: () => override };
        if (name === "lodash") return { extend: Object.assign };
        assert.match(name, /^\.\/strings\/[\w]+\.js$/);
        if (!dictionaries.has(name)) {
          const child = { exports: {} };
          const file = path.join(__dirname, "..", name);
          vm.runInNewContext(fs.readFileSync(file, "utf8"), { module: child }, { filename: file });
          dictionaries.set(name, child.exports);
        }
        return dictionaries.get(name);
      }
    },
    { filename }
  );
  return { strings: module.exports, preload, ready: () => callback(), dictionaries };
}
const translated = (f, file) => f.dictionaries.get(`./strings/${file}.js`);

test("dispatcher exports English immediately and updates the same reference only after preload", () => {
  const f = fixture("fr");
  const exported = f.strings;
  assert.equal(exported.agree, "Agree");
  f.ready();
  assert.equal(f.strings, exported);
  assert.equal(exported.agree, translated(f, "fr").agree);
});

test("explicit UI language overrides the request language", () => {
  const f = fixture("fr", "de-DE");
  f.ready();
  assert.equal(f.strings.agree, translated(f, "de_de").agree);
});

test("unsupported and absent languages retain English fallback", () => {
  for (const header of ["", "xx-YY", undefined]) {
    const f = fixture(header);
    f.ready();
    assert.equal(f.strings.agree, "Agree");
  }
});

test("Chinese regions select simplified or traditional dictionaries", () => {
  for (const [language, file] of [
    ["zh-CN", "zh_Hans"],
    ["zh-SG", "zh_Hans"],
    ["zh-MY", "zh_Hans"],
    ["zh-TW", "zh_Hant"],
    ["zh-HK", "zh_Hant"]
  ]) {
    const f = fixture(language);
    f.ready();
    assert.equal(f.strings.agree, translated(f, file).agree);
  }
});

test("Portuguese regional variants share the admitted Brazilian dictionary", () => {
  for (const language of ["pt", "pt-PT", "pt-BR", "pt-TL"]) {
    const f = fixture(language);
    f.ready();
    assert.equal(f.strings.agree, translated(f, "pt_br").agree);
  }
});

test("the first listed translated language wins shared keys over later choices", () => {
  const f = fixture("fr,de");
  f.ready();
  assert.equal(f.strings.agree, translated(f, "fr").agree);
});

test("missing translated keys preserve the English base", () => {
  const f = fixture("fr");
  const english = translated(f, "en_us"),
    french = translated(f, "fr");
  const key = Object.keys(english).find((candidate) => !Object.hasOwn(french, candidate));
  assert.ok(key, "fixture needs a real English fallback key");
  const original = english[key];
  f.ready();
  assert.equal(f.strings[key], original);
});

test("preload language is read when readiness fires rather than when imported", () => {
  const f = fixture("fr");
  f.preload.acceptLanguage = "ja-JP";
  f.ready();
  assert.equal(f.strings.agree, translated(f, "ja").agree);
});

test("independent imports do not share mutable translation state in this fixture", () => {
  const french = fixture("fr"),
    german = fixture("de");
  french.ready();
  assert.equal(german.strings.agree, "Agree");
  german.ready();
  assert.equal(french.strings.agree, translated(french, "fr").agree);
  assert.equal(german.strings.agree, translated(german, "de_de").agree);
});
