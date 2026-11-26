// The least of a page the map and its deepest zoom need in Node: elements
// that hold children, text and listeners, and canvases whose 2D context
// records its calls (text drawn included) and measures text by its length.
// Nothing is drawn. Imported first, before anything that draws.
let made = 0;

function recordingContext() {
  const log = [];
  const state = {};
  const size = () => {
    const m = /(\d+(?:\.\d+)?)px/.exec(state.font || "");
    return m ? Number(m[1]) : 10;
  };
  const answers = {
    measureText: (text) => ({ width: String(text).length * size() * 0.5 }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  return new Proxy(
    { log },
    {
      get(t, name) {
        if (name in t) return t[name];
        if (name in state) return state[name];
        return (...args) => {
          log.push([name, ...args.filter((a) => typeof a === "string" || typeof a === "number")]);
          return answers[name] ? answers[name](...args) : undefined;
        };
      },
      set(t, name, value) {
        state[name] = value;
        return true;
      },
    },
  );
}

export class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.id = String(made++);
    this.style = {};
    this.attributes = {};
    this.childNodes = [];
    this.parentNode = null;
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.width = 300;
    this.height = 150;
    this._text = "";
    this._ctx = null;
  }
  get textContent() {
    return this._text + this.childNodes.map((c) => c.textContent).join(" ");
  }
  set textContent(value) {
    this._text = String(value);
    this.childNodes = [];
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  appendChild(child) {
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this);
    this.parentNode = null;
  }
  getContext() {
    return this._ctx || (this._ctx = recordingContext());
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
}

globalThis.document = {
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => ({ textContent: String(text) }),
};
globalThis.getComputedStyle = () => ({ position: "relative" });
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
// Frames never come on their own: a test draws by settle().
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

export function host(w, h) {
  const el = new Element("div");
  el.clientWidth = w;
  el.clientHeight = h;
  return el;
}

// Every string any canvas in the element drew or was given, and every text
// the element holds: what a reader could see.
export function seen(el) {
  const out = [];
  const walk = (n) => {
    if (n._ctx) for (const call of n._ctx.log) for (const a of call.slice(1)) if (typeof a === "string") out.push(a);
    if (n._text) out.push(n._text);
    (n.childNodes || []).forEach((c) => (c instanceof Element ? walk(c) : out.push(c.textContent)));
  };
  walk(el);
  return out.join("\n");
}
