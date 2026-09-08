/**
 * Stylesheet stub for Jest.
 *
 * Replaces the `identity-obj-proxy` package in `moduleNameMapper` so component
 * tests run in any checkout, including a tree assembled without dev
 * dependencies. Behaviour is identical: any property read returns its own name,
 * which is what CSS-module consumers expect.
 */
module.exports = new Proxy(
  {},
  {
    get: (_target, key) => (key === "__esModule" ? false : key),
  }
);
