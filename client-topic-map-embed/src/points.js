/*
 * What the page adds to a stored map document before the map draws it: the
 * tooltip text of each point, and the one line of counts. No DOM.
 *
 * A map sent to a public reader ends with its held-back comments (moderated
 * out, inactive or muted when the request was made) as bare points: a
 * position, no id and no topic at any level. `points.moderatedOut` is how
 * many there are. client-topic-map draws a point with no topic grey, beneath
 * the others, so they need nothing to be drawn; their tooltip says so.
 */
import { TEXT } from "./load.js";

const count = (n) => n.toLocaleString("en-US");

/* How many of the last points are held back (0 when the field is absent). */
export function heldBackCount(doc) {
  const n = doc.points.id.length;
  const k = doc.points.moderatedOut;
  return Number.isInteger(k) && k > 0 ? Math.min(k, n) : 0;
}

/* A copy of the document whose points carry a text for each point: the
   document's own text where it has one, "Moderated out" for a held-back
   point, and "" otherwise (filled later by fillText). The document handed in
   is not changed. */
export function withTooltipText(doc) {
  const p = doc.points;
  const n = p.id.length;
  const first = n - heldBackCount(doc);
  const given = Array.isArray(p.text) ? p.text : [];
  const text = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i >= first) text[i] = TEXT.moderatedOut;
    else text[i] = typeof given[i] === "string" ? given[i] : "";
  }
  return { ...doc, points: { ...p, text } };
}

/* Puts each comment's text, by its id, into the points that have none yet;
   in place, because the map reads the text when it shows a tooltip. Returns
   how many points were given text. */
export function fillText(doc, byId) {
  const p = doc.points;
  const first = p.id.length - heldBackCount(doc);
  let filled = 0;
  for (let i = 0; i < first; i++) {
    if (p.text[i] || p.id[i] === null || p.id[i] === undefined) continue;
    const t = byId.get(p.id[i]);
    if (typeof t === "string" && t) {
      p.text[i] = t;
      filled += 1;
    }
  }
  return filled;
}

/* The line of counts under the buttons, only when something is held back:
   every point the map places, and how many of them are held back. */
export function countLine(doc) {
  const k = heldBackCount(doc);
  if (k === 0) return null;
  return `${count(doc.points.id.length)} comments · ${count(k)} moderated out, shown grey`;
}
