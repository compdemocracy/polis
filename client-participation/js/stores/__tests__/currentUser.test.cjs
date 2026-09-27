const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// Actual module; model mutation and shallow merge are explicit external doubles.
// Native promises exercise this module's callbacks, not jQuery settlement.
function fixture(firstUserPromise, existing = { retained: true }) {
  const sets = [];
  function Model() {
    this.set = (user) => sets.push(user);
  }
  const window = { userObject: existing };
  const dependencies = {
    backbone: { Model },
    jquery: { extend: Object.assign },
    "../util/preloadHelper": { firstUserPromise }
  };
  const module = { exports: {} };
  const filename = path.join(__dirname, "../currentUser.js");
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      window,
      require(name) {
        assert.ok(Object.hasOwn(dependencies, name), name);
        return dependencies[name];
      }
    },
    { filename }
  );
  return { model: module.exports, window, sets };
}

test("user update waits for preload before changing globals or the model", async () => {
  let resolve;
  const f = fixture(
    new Promise((done) => {
      resolve = done;
    })
  );
  const pending = f.model.update();
  assert.deepEqual(f.sets, []);
  assert.deepEqual(f.window.userObject, { retained: true });
  const user = { uid: 12, name: "Public participant" };
  resolve(user);
  assert.equal(await pending, user);
  assert.equal(f.sets[0], user);
});

test("user update merges other globals but clears only the global uid", async () => {
  const user = { uid: 12, name: "Public participant" };
  const existing = { retained: true, name: "Before", uid: 8 };
  const f = fixture(Promise.resolve(user), existing);
  await f.model.update();
  assert.equal(f.window.userObject, existing);
  assert.deepEqual(existing, { retained: true, name: user.name, uid: undefined });
  assert.equal(user.uid, 12);
  assert.equal(f.sets[0], user);
});

test("preload rejection propagates without publishing partial user state", async () => {
  const failure = new Error("public preload failure");
  const f = fixture(Promise.reject(failure));
  await assert.rejects(f.model.update(), (error) => error === failure);
  assert.deepEqual(f.sets, []);
  assert.deepEqual(f.window.userObject, { retained: true });
});

test("model update exceptions remain rejected and disclose earlier global mutation", async () => {
  const user = { uid: 12, name: "After" };
  const f = fixture(Promise.resolve(user));
  const failure = new Error("model setter");
  f.model.set = () => {
    throw failure;
  };
  await assert.rejects(f.model.update(), (error) => error === failure);
  assert.equal(f.window.userObject.name, "After");
  assert.equal(f.window.userObject.uid, undefined);
});

test("concurrent update calls both execute against the same resolved preload", async () => {
  const user = { uid: 12 };
  const f = fixture(Promise.resolve(user));
  assert.deepEqual(await Promise.all([f.model.update(), f.model.update()]), [user, user]);
  assert.deepEqual(f.sets, [user, user]);
});

test("independent module instances retain independent globals and model receivers", async () => {
  const a = fixture(Promise.resolve({ uid: 12, name: "First" }));
  const b = fixture(Promise.resolve({ uid: 13, name: "Second" }));
  await b.model.update();
  assert.deepEqual(a.sets, []);
  await a.model.update();
  assert.equal(a.window.userObject.name, "First");
  assert.equal(b.window.userObject.name, "Second");
});
