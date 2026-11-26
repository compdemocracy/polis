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
 * Nothing here throws, and nothing is kept beyond the one map and reader:
 * the reader's data (readerDataFor) is made afresh with every read of the
 * map, and the overlay goes with the map.
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
import { fillText } from "./points.js";

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

/* One reader's data for one drawn map: text() and math(), each asked for at
   most once, sharing one report read (skipped when the host gives the
   conversation id and moderation level). text() resolves to a Map of text by
   comment id (empty when anything fails), math() to the math result or null.
   Neither rejects. */
export function readerData(fetchFn, { reportId, conversationId = null, modLevel = null, token = null }) {
  let report = null;
  let text = null;
  let math = null;
  const given = conversationId && Number.isInteger(modLevel) ? { conversationId, modLevel } : null;
  const where = () => report || (report = given ? Promise.resolve(given) : readReport(fetchFn, reportId, { token }));
  return {
    text: () =>
      text ||
      (text = where()
        .then((r) =>
          r && r.modLevel !== null
            ? readCommentText(fetchFn, reportId, { conversationId: r.conversationId, modLevel: r.modLevel, token })
            : new Map(),
        )
        .catch(() => new Map())),
    math: () =>
      math ||
      (math = (conversationId ? Promise.resolve({ conversationId }) : where())
        .then((r) => (r ? readMath(fetchFn, r.conversationId, { token }) : null))
        .catch(() => null)),
  };
}

/* The reader's data, kept for one reader at a time (commentText.js): asked
   again by the same reader it is the same object, by any other a new one. */
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
   done (at once in the map's own drawing). */
export function wireMap({ map, element, data, inputs, drawing, DeepZoom = PolisTopicMapDeepZoom }) {
  let current = isDense(drawing) ? drawing : null;
  let destroyed = false;
  let asked = false;
  let joining = null;
  let got = null; // { math } once the join has its answers
  let overlay = null;

  const askText = () => {
    if (asked) return;
    asked = true;
    element.removeEventListener("pointermove", askText);
    if (!inputs) return;
    inputs.text().then((byId) => {
      if (!destroyed) fillText(data, byId);
    });
  };

  const attach = () => {
    if (destroyed || overlay || !got || !current) return;
    try {
      keepingView(map, () => {
        if (got.math) {
          overlay = new DeepZoom(map, {
            math: got.math,
            numbers: numbersForMap(got.math),
            drawing: typeof current === "object" ? current : undefined,
          });
        } else {
          map.setDrawing(current);
        }
      });
    } catch (e) {
      overlay = null;
    }
  };

  const join = () => {
    if (joining) return joining;
    asked = true;
    element.removeEventListener("pointermove", askText);
    if (!inputs) return (joining = Promise.resolve());
    joining = Promise.all([inputs.text(), inputs.math()]).then(([byId, math]) => {
      if (destroyed) return;
      fillText(data, byId);
      got = { math };
      attach();
    });
    return joining;
  };

  if (current) join();
  else element.addEventListener("pointermove", askText);

  return {
    get joined() {
      return joining || Promise.resolve();
    },
    overlay: () => overlay,
    setDrawing(next) {
      next = isDense(next) ? next : null;
      if (next === current) return;
      if (overlay) {
        overlay.destroy();
        overlay = null;
      }
      current = next;
      map.setDrawing(next);
      if (next) {
        join();
        attach();
      }
    },
    destroy() {
      destroyed = true;
      element.removeEventListener("pointermove", askText);
      if (overlay) overlay.destroy();
      overlay = null;
    },
  };
}
