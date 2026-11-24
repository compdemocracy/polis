/*
 * The dark theme of the topic map, made by the host as the package's README
 * says a theme is made ("copy the neutral theme, change the values, and hand
 * the copy to both"): a copy of client-topic-map/theme-neutral.js, unchanged
 * there, with its grounds and inks turned for a dark ground. Nothing in the
 * package changes.
 *
 * The rule: every token that is the ground's colour in the neutral theme (the
 * ground, the point outline, the label halo and plate, the tooltip's ground)
 * becomes the dark ground; every ink becomes a light ink. The topics' colours
 * from the document keep their hue and chroma; only their lightness is raised,
 * and only where it is below a floor, so they read on the dark ground:
 *   comments  OKLab L >= 0.64, so that drawn at the theme's opacity (180/255)
 *             over the dark ground a comment still reads at about OKLab 0.57
 *   names     OKLab L >= 0.74 (about 8:1), from the topic's own colour, since
 *             the document's darker label colour is made for a white ground
 * Unclustered comments stay a recessive grey, darker than on white so that
 * they recede here as #aaaaaa does there.
 */
export const DARK_GROUND = "#121212";

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16) / 255);
}
function toLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function fromLinear(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
function rgbToOklab(rgb) {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function oklabToLinear(lab) {
  const l = Math.pow(lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2], 3);
  const m = Math.pow(lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2], 3);
  const s = Math.pow(lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2], 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
function inGamut(lin) {
  return lin.every((c) => c >= -1e-6 && c <= 1 + 1e-6);
}

/* The colour with its lightness raised to at least `floor`, hue kept; chroma
   is reduced only as far as the sRGB gamut requires. */
export function lift(hex, floor) {
  const lab = rgbToOklab(hexToRgb(hex));
  if (lab[0] >= floor) return hex;
  let k = 1;
  let out;
  for (let i = 0; i < 40; i++) {
    out = oklabToLinear([floor, lab[1] * k, lab[2] * k]);
    if (inGamut(out)) break;
    k *= 0.95;
  }
  const rgb = out.map((c) => Math.round(255 * fromLinear(Math.min(1, Math.max(0, c)))));
  return "#" + rgb.map((c) => (c < 16 ? "0" : "") + c.toString(16)).join("");
}

/* The dark theme from the neutral one; the neutral object is not changed. */
export function darkTheme(neutral) {
  const memo = {};
  const lifted = (hex, floor) => {
    const key = hex + "|" + floor;
    if (!(key in memo)) memo[key] = lift(hex, floor);
    return memo[key];
  };
  const own = (topic, level) => (level === "all" ? topic.colorAll : topic.color);

  const dark = JSON.parse(JSON.stringify(neutral));
  dark.name = "dark (host page)";
  dark.ground = DARK_GROUND;
  dark.ink = "#ececec";
  dark.inkMuted = "#8c8c8c";
  dark.rule = "#333333";
  dark.point.fill = (topic, level) => lifted(own(topic, level), 0.64);
  dark.point.unclustered = "#5f5f5f";
  dark.point.stroke = "rgba(18,18,18,0.502)";
  dark.point.hover = "rgba(255,92,92,0.85)";
  dark.label.ink = (topic, level) => lifted(own(topic, level), 0.74);
  dark.label.halo = "rgba(18,18,18,0.867)";
  dark.label.plate = "rgba(18,18,18,0.251)";
  dark.tooltip.ink = "#ececec";
  dark.tooltip.ground = "rgba(34,34,34,0.94)";
  dark.tooltip.shadow = "2px 3px 10px rgba(0,0,0,0.6)";
  dark.list.hoverGround = "#1f1f1f";
  dark.list.selectedGround = "#2e2e2e";
  return dark;
}
