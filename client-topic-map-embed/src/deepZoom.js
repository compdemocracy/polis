/*
 * What one drawn map asks for beside the map document, and the deepest zoom
 * of the dense drawing joined onto it. No Solid here, so the tests run in
 * Node with a small stand-in for the page.
 *
 * The map's own drawing is as it was: comment text for the tooltips is asked
 * for at the first pointer move over the map (load.js, request 3), and
 * nothing else.
 *
 * The dense drawing asks, once per drawn map and reader, as soon as the map
 * is drawn (it never waits for them: the map draws first and the join
 * arrives after), for the comment list (the same request, never a second)
 * and the conversation's math result (load.js, request 4). Both are joined
 * onto the points that carry a comment id, and only those: a comment held
 * back from this reader reaches the page as a bare point with no id, so
 * nothing in the comment list or the math result can be attached to it,
 * whatever they hold. The math result is never trusted to say what is
 * visible: it carries counts for comments this reader may not see, and the
 * page reads them only by the id of a point it was sent.
 *
 *   - Comment text goes into points.text, as for the tooltips.
 *   - With the math result, client-topic-map's PolisTopicMapDeepZoom is put
 *     over the map: the comments that stand out on the whole map (worked out
 *     here, over the points with an id) written out at the deepest zoom, each
 *     with the four rows of how each opinion group voted; any other comment
 *     revealed on hover and selected on click.
 *   - Without it (no answer, an error, no per-group counts), no overlay: the
 *     dense drawing labels the comments with their text by its own rule, and
 *     the tooltip shows the text; no graphic is drawn anywhere.
 *   - Without the comment list, no comment has text, so none is written out;
 *     with the math result the overlay's cards still name the topic and show
 *     the counts.
 * Both answers are cut to the map's own ids the moment they arrive
 * (projectText, projectMath), before anything keeps them or hands them to
 * client-topic-map, so no text, id or count of a comment held back from
 * this reader is kept anywhere on the page; the answers themselves are not
 * kept. (They still reached the browser: the two routes are public.)
 * Nothing here throws, and nothing is kept beyond the one map and reader:
 * the reader's data (readerDataFor) is made afresh with every read of the
 * map, and the overlay goes with the map. Each join has a lifetime that is
 * revoked when its map goes (destroyed, or replaced for another document,
 * run, selection or reader): its reads are aborted, everything it cut is let
 * go of at once, and an answer arriving after it is dropped unread, so a
 * request still pending keeps nothing of a reader that is gone.
 *
 * Counts: the math result's group-votes give, per opinion group and comment,
 * A (agrees), D (disagrees) and S (votes of any kind, passes included), as
 * the report reads them (client-report normalizeConsensus.js). They are read
 * as counts by client-topic-map (vote-graphic.js groupsFromMath, and
 * highlights.js for group-informed consensus), and here only to sum S for
 * the floor of votes below. No signed vote is read anywhere.
 */
import PolisTopicMapDeepZoom from "../../client-topic-map/deep-zoom.js";
import PolisTopicMapHighlights from "../../client-topic-map/highlights.js";
import { isDense, readCommentText, readMath, readReport } from "./load.js";
import { commentTextFor } from "./commentText.js";
import { fillText, heldBackCount } from "./points.js";

/* The numbers the standouts are chosen by, from the math result alone:
   group-informed consensus and division as client-topic-map computes them,
   and, for the floor of votes, each comment's votes from the members of the
   opinion groups, passes included (the sum over the groups of S). The floor
   is taken from the math result, not from the comment list: asking the list
   for its counts (include_voting_patterns) makes Node count every vote of the
   conversation on its shared pool, the pool votes are written through. */
export function numbersForMap(math) {
  const numbers = PolisTopicMapHighlights.numbersFrom(math, null);
  const votes = {};
  const gv = (math && math["group-votes"]) || {};
  for (const gid of Object.keys(gv)) {
    const byComment = (gv[gid] && gv[gid].votes) || {};
    for (const tid of Object.keys(byComment)) {
      const seen = byComment[tid] && byComment[tid].S;
      if (typeof seen === "number" && Number.isFinite(seen) && seen >= 0) votes[tid] = (votes[tid] || 0) + seen;
    }
  }
  numbers.votes = votes;
  return numbers;
}

/* The comment ids this reader was given: every point of the map document
   that carries one (a held-back point carries none, and the held-back points
   are the last ones), in the document's order, each once. */
export function allowedIds(doc) {
  const p = doc && doc.points;
  if (!p || !Array.isArray(p.id)) return [];
  const first = p.id.length - heldBackCount(doc);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < first; i++) {
    const id = p.id[i];
    if (Number.isInteger(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/* The projection: each read cut down to the comments this reader was given
   (allowed, a Set of ids) as soon as it arrives, before it is kept, cached or
   handed to client-topic-map. The comment list and the math result are
   public answers that carry comments the map holds back from this reader;
   nothing of those (no text, no id, no count) is kept, and nothing keeps the
   answers themselves. */
const isCount = (v) => typeof v === "number" && Number.isFinite(v);
const allowedTid = (allowed, tid) => allowed.has(Number(tid));

/* Text by comment id, for the allowed ids only. */
export function projectText(byId, allowed) {
  const out = new Map();
  if (!(byId instanceof Map)) return out;
  for (const [tid, txt] of byId) if (allowedTid(allowed, tid) && typeof txt === "string") out.set(tid, txt);
  return out;
}

/* The math result as client-topic-map reads it, for the allowed ids only:
   group-votes (each group's n-members, and per allowed comment its counts A,
   D and S, named counts as they arrive), tids and pca comment-extremity
   (kept aligned). Every other field of the answer is dropped. null when the
   answer carries no group-votes. */
export function projectMath(math, allowed) {
  const gv = math && math["group-votes"];
  if (!gv || typeof gv !== "object" || Array.isArray(gv)) return null;
  const groups = {};
  for (const gid of Object.keys(gv)) {
    const g = gv[gid];
    if (!g || typeof g !== "object") continue;
    const group = { votes: {} };
    if (isCount(g["n-members"])) group["n-members"] = g["n-members"];
    const from = g.votes && typeof g.votes === "object" ? g.votes : {};
    for (const tid of Object.keys(from)) {
      const v = from[tid];
      if (!allowedTid(allowed, tid) || !v || typeof v !== "object") continue;
      const counts = {};
      for (const k of ["A", "D", "S"]) if (isCount(v[k])) counts[k] = v[k];
      group.votes[tid] = counts;
    }
    groups[gid] = group;
  }
  const tids = [];
  const extremity = [];
  const givenTids = Array.isArray(math.tids) ? math.tids : [];
  const givenExtremity = math.pca && Array.isArray(math.pca["comment-extremity"]) ? math.pca["comment-extremity"] : [];
  for (let i = 0; i < givenTids.length && i < givenExtremity.length; i++) {
    if (!allowedTid(allowed, givenTids[i]) || !isCount(givenExtremity[i])) continue;
    tids.push(givenTids[i]);
    extremity.push(givenExtremity[i]);
  }
  return { "group-votes": groups, tids, pca: { "comment-extremity": extremity } };
}

/* One reader's data for one drawn map, for one lifetime: text() and math(),
   each asked for at most once, sharing one report read (skipped when the
   host gives the conversation id and moderation level), each cut to the
   reader's ids (those of the map document it was drawn from: allowedIds) the
   moment it arrives. text() resolves to a Map of text by comment id (empty
   when anything fails), math() to the projected math result or null.
   Neither rejects. Without ids nothing is kept.

   revoke() ends the lifetime (wireMap's destroy calls it: the map is
   destroyed or replaced, by another document, run, selection or reader). At
   once, whether or not a read is still pending: the reads are aborted (where
   the fetch honours an abort signal; nothing relies on it), every cut is let
   go of, a read not yet settled settles empty, and an answer that arrives
   later is dropped unread, neither cut nor kept. Every callback a pending
   read holds reaches the lifetime's state only through `held`, which revoke
   empties, so a stalled request keeps nothing of this reader alive. */
export function readerData(fetchFn, { reportId, conversationId = null, modLevel = null, token = null, ids = [] }) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const signal = controller ? controller.signal : null;
  const given = conversationId && Number.isInteger(modLevel) ? { conversationId, modLevel } : null;
  // All the lifetime keeps: the reader's ids, the report read, the two reads
  // (each a promise of its cut) and how to settle them empty.
  let held = { allowed: new Set(Array.isArray(ids) ? ids : []), report: null, reads: {}, settles: [] };
  const where = () => {
    if (!held) return Promise.resolve(null);
    return held.report || (held.report = given ? Promise.resolve(given) : readReport(fetchFn, reportId, { token, signal }));
  };
  // One read: a promise that settles with its answer cut (project) when the
  // answer arrives in a live lifetime, or empty at once when the lifetime is
  // revoked first. The read's callbacks hold settle, never the cut.
  const once = (name, empty, read, project) => {
    if (!held) return Promise.resolve(empty());
    if (held.reads[name]) return held.reads[name];
    let settle;
    const kept = new Promise((resolve) => {
      settle = resolve;
    });
    held.reads[name] = kept;
    held.settles.push(() => settle(empty()));
    read()
      .then((answer) => settle(held ? project(answer, held.allowed) : empty()))
      .catch(() => settle(empty()));
    return kept;
  };
  return {
    text: () =>
      once(
        "text",
        () => new Map(),
        () =>
          where().then((r) =>
            r && r.modLevel !== null
              ? readCommentText(fetchFn, reportId, { conversationId: r.conversationId, modLevel: r.modLevel, token, signal })
              : null,
          ),
        projectText,
      ),
    math: () =>
      once(
        "math",
        () => null,
        () =>
          (conversationId ? Promise.resolve({ conversationId }) : where()).then((r) =>
            r ? readMath(fetchFn, r.conversationId, { token, signal }) : null,
          ),
        projectMath,
      ),
    get revoked() {
      return held === null;
    },
    revoke() {
      const h = held;
      if (!h) return;
      held = null;
      const settles = h.settles;
      h.allowed = h.report = h.reads = h.settles = null;
      for (const s of settles) s();
      if (controller) controller.abort();
    },
  };
}

/* The reader's data, kept for one reader and one map's ids at a time
   (commentText.js): asked again by the same reader for the same ids it is
   the same object, by any other a new one. */
export function readerDataFor(fetchFn) {
  return commentTextFor((reader) => readerData(fetchFn, reader));
}

/* Runs fn (which gives the map its drawing again, so that the comments' text
   is read) and puts the view back where the reader had moved it: the map
   returns to its first view whenever its drawing is set. Keep an active
   zoom too, including one whose first frame has not happened yet. */
export function keepingView(map, fn) {
  const animation = map.drawing && map._anim;
  const moved = map.drawing && map._view && typeof map._denseAtFit === "function" && (animation || !map._denseAtFit());
  const view = moved ? Object.assign({}, map._view) : null;
  try {
    fn();
  } finally {
    if (view && map.drawing) {
      map._view = view;
      map._anim = animation;
      map.redraw();
    }
  }
}

/* The asks and the overlay of one drawn map, in either drawing.
   map: the PolisTopicMap; element: its element; data: the document it draws
   (whose points.text is filled in place); inputs: readerData(...) for this
   map and reader, or null for no comment text and no math; drawing: the
   drawing it was made with. Returns { setDrawing(drawing), overlay(),
   joined, destroy() }; joined resolves when the dense drawing's join is
   done (at once in the map's own drawing), or when the wiring is destroyed.

   The wiring owns its reader's lifetime: destroy() revokes the inputs and
   lets go of the map, the document, the overlay and both reads' cuts at
   once, even while a read is still pending. Every callback reaches that
   state only through `own`, which destroy empties; nothing waits for the
   other read (no Promise.all, whose pending aggregate would hold the read
   that came first). */
export function wireMap({ map, element, data, inputs, drawing, DeepZoom = PolisTopicMapDeepZoom }) {
  let own = {
    map,
    element,
    data,
    inputs,
    DeepZoom,
    current: isDense(drawing) ? drawing : null,
    overlay: null,
    text: null, // the cut text, between its arrival and the math result's
    hasText: false,
    math: null, // the cut math result, once the join has its answers
    hasMath: false,
    got: false,
  };
  let asked = false;
  let joining = null;
  let finish = null;
  const done = () => {
    const f = finish;
    finish = null;
    if (f) f();
  };

  const askText = () => {
    if (asked || !own) return;
    asked = true;
    own.element.removeEventListener("pointermove", askText);
    if (!own.inputs) return;
    own.inputs.text().then((byId) => {
      if (own) fillText(own.data, byId);
    });
  };

  const attach = () => {
    const o = own;
    if (!o || o.overlay || !o.got || !o.current) return;
    try {
      keepingView(o.map, () => {
        if (o.math) {
          o.overlay = new o.DeepZoom(o.map, {
            math: o.math,
            numbers: numbersForMap(o.math),
            drawing: typeof o.current === "object" ? o.current : undefined,
          });
        } else {
          o.map.setDrawing(o.current);
        }
      });
    } catch (e) {
      o.overlay = null;
    }
  };

  // Both answers in: the text onto the document, the overlay over the map.
  const arrive = () => {
    if (!own || !own.hasText || !own.hasMath) return;
    fillText(own.data, own.text);
    own.text = null;
    own.got = true;
    attach();
    done();
  };

  const join = () => {
    if (joining) return joining;
    asked = true;
    if (!own) return (joining = Promise.resolve());
    own.element.removeEventListener("pointermove", askText);
    if (!own.inputs) return (joining = Promise.resolve());
    joining = new Promise((resolve) => {
      finish = resolve;
    });
    own.inputs.text().then((byId) => {
      if (!own) return;
      own.text = byId;
      own.hasText = true;
      arrive();
    });
    own.inputs.math().then((math) => {
      if (!own) return;
      own.math = math;
      own.hasMath = true;
      arrive();
    });
    return joining;
  };

  if (own.current) join();
  else own.element.addEventListener("pointermove", askText);

  return {
    get joined() {
      return joining || Promise.resolve();
    },
    overlay: () => (own ? own.overlay : null),
    setDrawing(next) {
      const o = own;
      if (!o) return;
      next = isDense(next) ? next : null;
      if (next === o.current) return;
      if (o.overlay) {
        o.overlay.destroy();
        o.overlay = null;
      }
      o.current = next;
      o.map.setDrawing(next);
      if (next) {
        join();
        attach();
      }
    },
    destroy() {
      const o = own;
      if (!o) return;
      own = null;
      o.element.removeEventListener("pointermove", askText);
      if (o.overlay) o.overlay.destroy();
      if (o.inputs && typeof o.inputs.revoke === "function") o.inputs.revoke();
      for (const k of Object.keys(o)) o[k] = null;
      done();
    },
  };
}
