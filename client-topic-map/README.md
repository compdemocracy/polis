# The topic map package

Two browser components that show the topics of a conversation's comments, and
the theme they are drawn with:

- `topic-map.js`, **PolisTopicMap**: every comment as a point placed by what it
  says (its UMAP position from a Delphi run), coloured by its topic, with the
  topic names on top. One level of topics at a time, or all levels together.
  It draws on one canvas and uses no library.
- `topic-list.js`, **PolisTopicList**: the same topics as a tree of buttons,
  each topic under the coarser topic that holds most of its comments.
- `theme-neutral.js`, **the neutral theme**: every colour, type size, stroke,
  spacing and duration either component uses, in one plain object. Nothing
  visual is written anywhere else.

The two components share nothing but the document they draw, the theme and
their events. A page that shows both carries each one's events to the other.

The package has no dependencies and no build step. Each script works as a
classic `<script>` (it defines `window.PolisTopicMap`, `window.PolisTopicList`
or `window.POLIS_TOPIC_MAP_THEME_NEUTRAL`) and as a CommonJS module
(`module.exports`). It loads nothing from any host: no URL, request or font
fetch from outside the page's own files (`test/self-contained.test.js`).

No client uses it yet.

## Files

| File | What it is | Bytes |
| --- | --- | ---: |
| `topic-map.js` | the map | 62,363 |
| `topic-list.js` | the list | 7,976 |
| `theme-neutral.js` | the neutral theme | 5,754 |
| `dense.js` | the dense drawing's rules, as pure functions (the map draws them with `drawing: "dense"`) | 35,593 |
| `highlights.js` | which comments to bring forward over the map: those that stand out as most consensus or most divisive, of the whole map and of each topic, and the topics that stand out, as pure functions | 14,795 |
| `vote-graphic.js` | the group vote graphic beside one comment, as pure functions (two forms: four rows, filled; poured) | 32,422 |
| `deep-zoom.js` | the deepest zoom over the dense drawing: the comments that stand out on the whole map (by `highlights.js`) as the only comment labels, each with the four rows (`vote-graphic.js`) in its reserved box; at the deepest step every other comment's first words beside its dot where there is room; the comment nearest the pointer revealed on hover or focus, and selected on click with the poured form and the counts in words | |
| `fonts/roboto.css` | the `@font-face` rule for the font below | 270 |
| `fonts/Roboto-latin-wght.woff2` | Roboto, variable weight 100 to 900, latin subset | 37,520 |
| `fonts/OFL.txt` | the font's licence, SIL Open Font License 1.1 | 4,394 |
| `NOTICE` | notices for the work this package is derived from or carries | |
| `test/` | Node tests and two small public fixtures | |

## Using the components

```js
var map = new PolisTopicMap(mapElement, { data: data, theme: theme, level: 0 });
var list = new PolisTopicList(listElement, { data: data, theme: theme, level: 0 });

mapElement.addEventListener("topicselect", function (e) {
  // e.detail: { topic, previous, origin }
  if (e.detail.origin !== "api") list.select(e.detail.topic);
});
listElement.addEventListener("topicselect", function (e) {
  if (e.detail.origin !== "api") map.select(e.detail.topic);
});

map.select("1_4");   // a topic id, or null to clear
map.hover("0_12");
map.setLevel(2);     // a level number, or "all"
map.setTheme(otherTheme);
map.destroy();
```

`data` is a `polis-topic-map/1` document (below) and `theme` a theme object
such as the neutral theme.

### The map: PolisTopicMap(element, options)

The map fills `element`: it appends a canvas and a tooltip to it (and sets
`position: relative` on it if it was `static`), so give the element a size. It
draws again when the element is resized.

Options:

| Option | Meaning | Default |
| --- | --- | --- |
| `data` | the document to draw; or call `setData` later | none |
| `theme` | the theme object; needed when the map is built | none |
| `level` | the level shown: a level number, or `"all"` for every level together | `0` |
| `selected` | a topic id to select at once (needs `data`); this dispatches a `topicselect` with origin `"api"` while the map is built | none |
| `projection` | `"web-mercator"`, as datamapplot's maps are drawn, or `"linear"`, the UMAP positions with no stretch | `"web-mercator"` |
| `collision` | which names show where names compete: `"as-drawn"`, as datamapplot's maps show them today, or `"by-weight"`, the rule datamapplot asks for (larger topics first) | `"as-drawn"` |
| `drawing` | `null` for the map as described here, or `"dense"` (or an object of settings) for the dense drawing: see [The dense drawing](#the-dense-drawing-the-drawing-option) | `null` |
| `ground` | in the dense drawing, `"comments"` (comments and their votes over a grey map wherever comments are written out) or `"topics"` (no comment written out, the topics in colour): see [The grey ground](#the-grey-ground) | `"comments"` |

Methods:

| Method | What it does |
| --- | --- |
| `setData(data)` | draws another document; clears the selection and the hover (without events) and returns to the first view |
| `setTheme(theme)` | draws with another theme |
| `setLevel(level, origin)` | shows another level; dispatches `levelchange` if the level changed. Throws for a level the document does not have |
| `select(id, origin)` | selects a topic, or clears the selection with `null`; dispatches `topicselect` if the selection changed. Throws for an unknown id |
| `hover(id, origin)` | marks a topic as hovered, or none with `null`; dispatches `topichover` if it changed. Throws for an unknown id |
| `setCollision(mode)` | `"as-drawn"` or `"by-weight"`, as the option |
| `setGround(ground)` | `"comments"` or `"topics"`, as the option; draws at once in the same view |
| `setDrawing(settings)` | `null`, `"dense"` or the dense drawing's settings, as the `drawing` option; draws at once |
| `settle()` | finishes at once any work on which names show and draws the result (in the dense drawing: ends the zoom in progress and places the names for that view) |
| `resetView()` | returns to the first view (in the dense drawing, the fit) and draws |
| `denseLayout()` | in the dense drawing, the settled placement: `{ width, height, view, fit, zoom, names, comments, commentLevel }` (see below); otherwise `null` |
| `redraw()` | draws again at the next frame |
| `destroy()` | removes the canvas, the tooltip and every listener |

It also has the properties `level`, `selected`, `hovered`, `collision`,
`projection`, `ground`, `grey` (whether the grey ground is on) and `canvas`, and an optional `onTiming` callback, unset by
default, called as `onTiming(kind, milliseconds)` with `kind` `"draw"` for a
redraw and `"claims"` for a slice of the work on which names show.
`PolisTopicMap.geometry` holds the pure rules the tests check.

What a person can do on the map: drag to move it; turn the wheel to zoom about
the pointer (250 ms); double-click to zoom in one step (with Shift, out; 300
ms); pinch with two fingers. Pointing at a comment shows its text in a tooltip,
always as text and never as HTML, and hovers its topic; pointing at a drawn name
hovers that topic. A click on a comment or a name selects its topic; a click on
the selected topic again, or on empty ground, clears the selection. Selecting a
topic dims the other comments and enlarges its own, and its name always shows.
There is no keyboard control.

### The dense drawing: the `drawing` option

With `drawing: "dense"` (or `setDrawing("dense")`) the map draws the dense
map, by the rules in `dense.js` (load it before `topic-map.js`): the ground;
each zone (the coarsest level) as a tint and an outline, zone by zone; each
district (the level below) as a dashed outline; every comment as a grey dot,
held-back comments included; then the names of the zones, the districts and
the finest level together, each with its halo, placed so that none overlaps
another, shrunk to fit or left out.

An object instead of `"dense"` is merged over `PolisTopicMapDense.PRESET_DENSE`
key by key: `{ wrap: { zone: 18 } }` changes only that key. The names are
measured and drawn in `fontSans` and `fontMono` (the zone names), which default
to the theme's `font.family`.

What differs from the default drawing while it is selected:

- the positions are drawn linearly (y up), fitted to the extent of every point
  with a pad of 3% of the smaller side; on a map with room (at least
  `zoom.surface.minAreaPerPoint`, 6000, px² of frame per point) the pad is
  widened so that every zone's shape lies inside the frame with `fitMargin`
  (8) px to spare (`fitFor`, `zoneReach`): a zone of lone points reaches
  about two and a half blur widths past them; `projection`, `level`, `collision`, the
  theme's colours and the document's colours do not apply;
- the gestures are the default drawing's (drag, the wheel and a pinch about the
  pointer, double-click in and Shift-double-click out), within the zoom
  settings' limits; hovering a comment's dot shows its text in the tooltip and
  hovers the finest topic that holds it, hovering a name hovers its topic, and a
  click selects as in the default drawing, with the same events. The settings
  `hover` and `click` are refused: both are always on;
- zones, districts and dots scale with the view; names keep their size in
  pixels. The zones and districts are worked out once for the element's size,
  at the fit (the picture at rest), and every other view draws those same
  shapes scaled and moved (`fixedShapes`, `shapeTransform`), their strokes at
  the same width on screen; a zone's tint turns to its zoomed tint smoothly
  between the fit and the first step (`zoomedTintShare`). While the view
  moves, the last placement is drawn moved with it (a waypoint kept inside the
  view at its edge); when the view (or the element's size) has not changed
  for `zoom.settleMs` (120 ms) the names are placed again for that view, so
  going in shows names that had no room, and a name whose anchor has left the
  view takes none. Each placement starts from the one before (`layout`'s
  `prev`): a name or comment label is tried first where it was on the map,
  then at its previous offset from its anchor, and the others keep out of the
  places it held, so the same view gives the same placement and a small pan
  moves no name. Over `zoom.fadeMs` (240 ms) a name on screen before and after
  slides to its new place and one that comes or goes fades; `settle()`,
  `resetView()` and a reader who asks for less motion
  (`prefers-reduced-motion`) get the end at once. A double-click step eases
  from the old view to the new (a wheel notch eases out), or cuts to it with
  less motion;
- zoomed in until the points in view are few and far apart, each point with
  text and an id is labelled with its first words, placed after the names by
  the same rule (the most voted first when the document has `points.votes`);
  the further in, the more words. A document without text never shows them;
- each placement dispatches `densestats`, whose `caption` is a line of counts a
  page can show ("Drawn now at 1408 by 803 px: 69 topic names (…)."), and
  `densecomments`, the comment labels placed.

The zoom settings are the key `zoom` of the drawing's settings, merged over
`PolisTopicMapDense.PRESET_ZOOM` (its `comments` key by key too):

| Setting | What it does | Preset |
| --- | --- | --- |
| `min`, `max` | the zoom's limits, as multiples of the fitted scale | `0.8`, `40` |
| `settleMs` | how long the view or size must rest before names are placed again | `120` |
| `hitRadiusMin` | the least radius, in px, at which a dot answers the pointer | `3` |
| `comments.maxPoints` | comment labels only when at most this many points are in view | `150` |
| `comments.minSpacing` | and when the median distance from each point in view to its nearest neighbour is at least this, in px | `24` |
| `comments.font` | the labels' size, in px | `10` |
| `comments.words`, `comments.wordsPerDoubling` | words shown at the fit, and added per doubling of the zoom (the rest cut with "…") | `5`, `2.5` |
| `comments.wrap`, `comments.wrapPerDoubling` | characters per line at the fit, and added per doubling | `22`, `6` |
| `comments.only` | a list of point ids: only those points get a label, the first placed first (an empty list gives none); `null`, every point with text, the most voted first | `null` |
| `comments.maxLines` | at most this many lines of a label, the last cut with "…"; `null`, no limit | `null` |
| `comments.align` | `"left"` draws each label's lines from its text's left edge; otherwise they are centred | centred |
| `comments` | `false` turns comment labels off | |
| `fadeMs` | how long a name kept slides, and one that comes or goes fades, after names are placed again (0: at once) | `240` |
| `slot` | `{ w, h, gap }`: a box w by h px reserved gap px to the right of each comment label's text, taken into its room when it is placed; nothing is drawn in it | `null` |

A placed comment label, in `denseLayout().comments` and in the `comments` of
`densecomments`, is `{ point, id, text, cut, lines, x, y, w, h, box, slot }`:
the point's index and id, the words shown, the text's centre and size, the box
it takes (text, gap and slot, with a margin of 1.5 px) and the reserved box
`{ x, y, w, h }` (top left, CSS px, at the settled view), or `null`.

`setDrawing(null)` returns to the default drawing, drawn exactly as before.

```js
var map = new PolisTopicMap(element, { data: doc, theme: theme, drawing: "dense" });
element.addEventListener("densestats", function (e) { caption.textContent = e.detail.caption; });
```

### The list: PolisTopicList(element, options)

The list replaces the content of `element` with a tree (`role="tree"`) of
buttons (`role="treeitem"`), one per topic: coarsest topics first, each topic
under its parent, and inside a parent in cluster order. Each row has the
topic's colour, its name and its number of comments. Rows of the list's level
(a host keeps it the map's) are in full ink and the others muted.

Options: `data`, `theme`, `level` and `selected`, as the map's.

Methods: `setData(data)`, `setTheme(theme)`, `setLevel(level)` (it dispatches
no event: only the map dispatches `levelchange`), `select(id, origin)`,
`hover(id, origin)` and `destroy()`, as the map's. A row selected from outside
the list is scrolled into view.

What a person can do on the list: point at a row, or move the focus to it, to
hover its topic; click a row to select its topic, and click it again to clear
the selection.

### Events

Each component dispatches its events on its own element, as a `CustomEvent`
that bubbles, with the details in `event.detail`. An event is dispatched only
when something changed.

| Event | From | `detail` |
| --- | --- | --- |
| `topicselect` | map, list | `{ topic, previous, origin }`: `topic` is the selected topic's id, or `null` when the selection was cleared; `previous` is the one before |
| `topichover` | map, list | `{ topic, previous, origin }`: `topic` is the hovered topic's id, or `null` |
| `levelchange` | map | `{ level, previous, origin }`: a level number, or `"all"` |
| `densestats` | map, dense drawing only | `{ caption, width, height, placed, byLayer, dropped, layerTotals, zoneCount, shrunk, shiftMedian, shiftP90, zoom, comments }`: what the dense drawing placed, dispatched each time it places the names (at the first draw, after a resize or a gesture has settled, when a face loads) |
| `groundchange` | map, dense drawing only | `{ grey, ground }`: the grey ground turned on (`grey` true) or off |
| `densecomments` | map, dense drawing only | `{ zoom, on, inView, spacing, comments }`: whether the view is close enough for comment labels (points in view, their median nearest-neighbour spacing in px) and the labels placed, dispatched with every `densestats` |

`origin` says where the change came from: `"map"` when a person did it on the
map, `"list"` when a person did it in the list, and `"api"` when the host called
a method. A host that mirrors state both ways ignores the events whose origin is
`"api"`, which are the echo of its own calls. A host may instead pass its own
word as the method's second argument (`map.setLevel(2, "host")`), and the event
then carries that word as its origin.

## The document it draws: `polis-topic-map/1`

One JSON document per Delphi run, written once when the run is made. It holds
everything about the map that depends only on the run; everything that depends
on the element's size, the zoom or the theme is worked out in the browser.
`test/fixtures/biodiversity.topic-map.json` is one, for a public conversation of
154 comments.

```js
{
  "schema": "polis-topic-map/1",
  "title": "…",               // the conversation; the map's accessible name uses it
  "attribution": "…",         // for the page to show; neither component shows it
  "run": { "jobId": "…", "topicModel": "…", "createdAt": "…" },
  "bounds": [xmin, xmax, ymin, ymax],  // the area of the first view, in UMAP units
  "pointRadius": 0.11,        // a comment's radius, in UMAP units
  "levels": [                 // finest first; level 0 has the most topics
    { "level": 0, "topics": 10, "unclustered": 47, "cmapPalette": false }
  ],
  "topics": [
    {
      "id": "0_3",            // the id every method and event uses
      "level": 0, "cluster": 3, "key": "…",
      "name": "0_3: …",       // as the naming stage stored it
      "count": 18,            // comments in the topic
      "x": -7.39, "y": 8.99,  // where its name is anchored, in UMAP units
      "weight": 2.06,         // the fourth root of count; the type size follows it
      "parent": "1_0",        // the topic one level coarser that holds most of its comments, or null
      "parentShare": 1.0,     // the share of its comments that parent holds, or null
      "color": "#dd6a94", "labelColor": "#734252",        // at its own level
      "colorAll": "#dd6a94", "labelColorAll": "#734252"   // when every level is shown together
    }
  ],
  "points": {                 // one entry per comment, in the same order in every array
    "id": [ … ], "x": [ … ], "y": [ … ],
    "topic": [ [ … ], [ … ] ],  // per level: the index in "topics" of each comment's topic, or -1 for none
    "text": [ … ],              // what the tooltip shows, and the dense drawing's comment labels
    "votes": [ … ]              // optional: votes per comment, which the dense drawing labels first
  }
}
```

The components read `schema`, `title`, `bounds`, `pointRadius`, the number of
`levels`, every field of `topics` but `key` and `parentShare`, and all of
`points`. `attribution`, `run`, `key`, `parentShare` and the counts in `levels`
are for the page around them. A document with any other `schema` is refused.

## Theming by tokens

A theme is a plain object of the shape of `theme-neutral.js`: grounds and inks
shared by both components (`ground`, `ink`, `inkMuted`, `rule`), and groups for
the type (`font`), the comments (`point`), the topic names (`label`), the
tooltip (`tooltip`), the list (`list`) and the zoom durations (`motion`). Each
value's comment says which datamapplot value it reproduces, or that it is new.
The neutral theme is the look of datamapplot's maps.

Two tokens take more than a colour: `point.fill` (a comment's colour, also the
list's swatch) and `label.ink` (a name's colour). Each is either the word
`"topic"`, meaning each topic's own colours from the document (`color` and
`labelColor`, or `colorAll` and `labelColorAll` when every level is shown), or
one CSS colour for all, or a function `(topic, level) => colour`.

To theme the components, copy the neutral theme, change the values, and hand
the copy to both:

```js
var theme = structuredClone(POLIS_TOPIC_MAP_THEME_NEUTRAL);
theme.ground = "…";          // any token
theme.label.sizeMaxPx = 24;
map.setTheme(theme);
list.setTheme(theme);
```

`font.family` must name a face the page has, and `label.weight` a weight it has.

## The font

The map measures and draws the topic names on its canvas in `font.family`, and
which names show is worked out from the shapes of their letters. So the face is
part of the picture: with Roboto missing, the browser draws the names in another
face, and the map comes out different, down to which names show. The neutral
theme names `Roboto, sans-serif`, the face of datamapplot's
maps, and the package carries it: `fonts/Roboto-latin-wght.woff2` (variable
weight 100 to 900, latin subset, SIL Open Font License 1.1) and
`fonts/roboto.css`, which declares it:

```css
@font-face { font-family: "Roboto"; font-style: normal; font-weight: 100 900; font-stretch: 100%; src: url("./Roboto-latin-wght.woff2") format("woff2"); }
```

Load the style sheet on any page that shows the map; the map measures again when
a face finishes loading. The face is named `Roboto` on that page, so any other
style on the page that lists Roboto in its font stack gets this face too.

## The group vote graphic: `vote-graphic.js`

**PolisVoteGraphic** (`window.PolisVoteGraphic`, or `module.exports`) draws
the small graphic that sits beside one comment and shows how each opinion group
voted on it. It is two pure functions and a painter: no page, no measuring.

```js
var G = PolisVoteGraphic;
var groups = G.groupsFromMath(math, tid);     // from GET /api/v3/math/pca2
var L = G.layout(groups, { x: 0, y: 0, width: 34, height: 14 }, { form: "rows", scheme: "light" });
ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
G.draw(ctx, L);                               // fills only, inside the box
G.caption(L);                                 // describes the form and its smoothing
G.readout(L).lines;                           // ["Group A: 118 agreed, 9 disagreed, 52 passed, 64 did not vote (179 of 243 voted).", ...]
G.hit(L, x, y);                               // the group under a point (CSS px), or -1: for hover and click
```

`groups` is one object per opinion group, in order (A first):
`{ label, agree, disagree, pass, didNotVote, didNotSee }`. The counts are named
counts, never signed vote values. `didNotVote` is the group's members who cast
no vote on the comment; `didNotSee`, when known, is how many of those never saw
it (left out, the remainder is one part). `groupsFromMath(math, tid)` builds
them from the math result: `group-votes[gid].votes[tid]` gives `A` (agrees),
`D` (disagrees) and `S` (votes of any kind, passes included), and
`group-votes[gid]["n-members"]` the group's size; pass is `S - A - D` and did
not vote `n-members - S`. Group ids 0 through 9 are labelled A through J,
as in the report; gaps retain their letters. Other ids keep their id as the
label. Rows and columns remain in ascending group-id order.

Two forms, from the same groups into the same box, so a page can toggle
between them with the `form` setting:

- `"rows"` (the default), **four rows, filled**: one row per group, A at the
  top, filling the box so the rows read as one solid block. Each row runs the
  full width (inside an inset of 1 px when the box is under 16 px tall, else
  2 px): agree from the left to the group's share of agree, `(agree + 1) /
  (agree + disagree + 2)`, and disagree from there to the right end. Pass and
  those who did not vote are not drawn; their counts are in `readout`. These
  are smoothed shares, not the raw fractions: one agree and no disagrees
  draws two thirds agree; no agrees or disagrees draws half, even when all
  votes are passes. The caption explains this. The
  height is split into the rows and a 1 px lighter line between each two (the
  row above at half strength): row `i` runs from `round(i * (h + 1) / n)` to
  `round((i + 1) * (h + 1) / n) - 1` (`rowBands`), so at 14 px the rows are 3,
  3, 2 and 3 px, at 15 px 3 each, at 20 px 4, 5, 4 and 4. A 1 px line marks the
  middle, where agree is half. With `showNonVoters: true` the rows are the
  earlier drawing instead: agree, disagree and pass as shares of those who
  voted, then those who did not vote, a light tint with dots, at the right end,
  their share of the group times `didNotVoteMax` (0.25), at least a pixel;
  `didNotVoteMax: 1` draws every member to scale.
- `"poured"`: one column per group, A at the left. The upper bar is every
  member, the votes from the left and the rest dotted; the votes pour down from
  the voted part of the upper bar in an S bend and widen to fill the lower bar,
  where agree, disagree and pass are shares of those who voted across its whole
  width. The did-not-vote dots carry on below the upper bar into the space the
  liquid leaves at its upper right, behind the liquid (`pouredDots`, on by
  default), so that space is part of the picture rather than empty.

Every rectangle `layout` returns is on whole CSS pixels, so its edges land on
device pixels at any whole ratio (1, 2, 3) when the caller scales the canvas's
backing store by `devicePixelRatio` and sets that transform; the lines between
rows and down the middle stay 1 CSS px at every size. The poured liquid's
curved side has a point every half CSS px of height, filled by the canvas with
anti-aliasing at the backing store's resolution; the segments of a bar meet edge to edge and
fill it exactly; nothing is stroked and there is no outline, frame or padding.
Whole pixels are shared out by largest remainder, and any kind of vote that was
cast gets at least one pixel. The poured form's paths start and end on the
bars' edges and are painted one over another (all the votes, then agree and
disagree, then agree), so no seam opens between them. A box too small for the
groups gives `{ empty: true }` and `draw` paints nothing.

Settings (merged over `DEFAULTS`): `form`, `scheme` (`"light"` or `"dark"`,
the two grounds of the map), `gap` (px between groups, 1), `rowMax` (the
tallest row, 4 px), `few` (a group with fewer agrees plus disagrees than this,
5, has its votes drawn at `fewAlpha`, 0.45), `dotPitch` and `sawPitch` (the
dots' spacing), `pouredHeights` (upper bar, liquid, lower bar in proportion,
8 : 12 : 10), `mouthMin` (the voted part of the poured upper bar is at least
2 px), `letters` and `face` (the group letters at the left of rows 6 px or
taller, in the package's face), `didNotVoteMax` (above), and `colors`, any of
`{ agree, disagree, pass, tint, dots, letter, middle, hatchTint }` over the
scheme's. The default rows also take `showNonVoters` (false), `inset` (null,
as above), `separator` (1 px; 0 lets rows touch), `separatorAlpha` (0.5; 0
shows the ground), `middle` and `middleAlpha` (true, 0.6), and `disagreeFill`
(`"solid"`, or `"hatch"`: 1 px diagonal lines of disagree every `hatchPitch`,
3, px over `hatchTint`); `gap`, `rowMax`, `letters` and `didNotVoteMax` apply
to the rows only with `showNonVoters`. The poured form takes `pouredDots`.
`dotSize` is the side of a did-not-vote dot in whole px, its spacing
`dotPitch` (`sawPitch`) times that; left `null`, it is 1 in the rows and, in
the poured form, 1 px per 28 px of the box's height, at most a ninth of a
column (`dotSizeFor(n, box, settings)` gives it; every layout carries it as
`dotSize`): 1 px at 42×28, 2 px at 84×56, 3 px at 126×84, so a dot covers
the same share of its space at every size. The default
colours put a dark agree (`#004d40` on white) beside a light, strong red
disagree (`#eb5b3f`), far apart in lightness so the cut between them shows at
2 px rows; pass is a mid grey (`#8e949c`) and the did-not-vote tint
(`#e6e9ed`) is darker than the ground, so each row keeps its full length.
`SCHEMES` holds both grounds' defaults; `FIRST_SCHEMES` the colours of the
first drawing (the report's agree, disagree and pass), drawn with
`{ colors: FIRST_SCHEMES.light, didNotVoteMax: 1, showNonVoters: true }`.

`readout(groups or layout)` gives the numbers behind the graphic in plain
words, for a page to show on hover or click: `{ groups, lines, text }`, one
line per group ("Group A: 118 agreed, 9 disagreed, 52 passed, 64 did not vote
(179 of 243 voted)."). `hit(layout, x, y)` names the group whose row or column
is under a point in the box, or -1 outside it. The page does the event
handling; both are pure functions.

At four groups, a box 14 px tall gives 2 px rows with 1 px gaps; 15 px gives
3 px rows, 19 px gives 4 px.

## The dense drawing's rules: `dense.js`

**PolisTopicMapDense** (`window.PolisTopicMapDense`, or `module.exports`) holds
the rules of the dense drawing of the map: several layers named at once, the
coarsest as tinted and outlined zones, the next as dashed districts, every
comment a grey dot. They are pure functions: no page, no canvas. The map draws
them when its `drawing` option is `"dense"`.

```js
var D = PolisTopicMapDense;
var model = D.prepare(doc, D.PRESET_DENSE);            // what does not depend on size
var frame = D.layout(model, { width: 1408, height: 803, measure: measure });
var shapes = D.zoneShapes(model, frame);               // zone tints and outlines, district outlines
D.caption(frame);                                      // "Drawn now at 1408 by 803 px: 69 topic names (…)."
```

`measure(text, font)` is the caller's: it returns the width in px of one line
of text, where `font` is `{ weight, size, family, letterSpacing, font }` and
`font.font` is the CSS font string (`"606 25px …"`). In a browser it sets a
canvas's `font` and `letterSpacing` and calls `measureText`.

The settings are one plain object, merged over `DEFAULTS` key by key.
`PRESET_DENSE` is the drawing as approved. Layers are named by role, so the
preset does not depend on how many levels a document has: `"zone"` is the
coarsest level, `"district"` the level below it and `"finest"` level 0 (on a
four-level document, levels 3, 2 and 0). A layer may also be given by number.
`resolveSettings(settings, levels)` gives the settings by number. Documents of
fewer than three levels put two roles on one level; which drawing such
documents should get is not settled.

The names are set in two families, both settings: `fontMono` for the layers in
`monoLayers` (the zone names, in capitals) and `fontSans` for the others (the
district names in capitals, the finest names as written). Each is a CSS
font-family list. Both default to `DEFAULT_FACE`, the face the package already
draws its labels in (`Roboto, sans-serif`, the neutral theme's `font.family`);
the package has no monospace face, so the mono treatment uses the same face
until a setting names another. Sizes, weights, capitals, letter spacing,
wrapping, priority, placement and shrinking do not depend on the family; the
widths it measures do, so another face places a different set of names.

| Rule | Function |
| --- | --- |
| a topic's spread: the 75th-percentile distance of its points from its anchor, rounded to 3 decimals | `topicSpread(doc)` |
| the centre (mean of every point) and the extent of every point | `prepare` (`model.centre`, `model.extent`) |
| the first view: fit the extent with a pad of `pad × min(W, H)` | `fitView(extent, W, H, pad)` |
| zone hues: zones ordered by their angle around the centre, zone k of n at `25 + k × 360 / n` | `prepare` (`model.zoneHue`) |
| every topic's hue: its zone by parents, else the nearest zone; turned by `0.12 ×` its angle from the zone | `prepare` (`model.zoneOf`, `model.zoneBy`, `model.hueOf`) |
| a name's size by layer and count, `lo + (hi − lo) × √(count / layer max)` | `prepare` (`model.baseFont`) |
| weight `round(clamp(300 + (f − 7) × 17, 300, 760))` | `weightFor(f)` |
| the prefix `L_C: ` the naming stage stores, removed | `stripNamePrefix(name)` |
| wrapping by character count | `wrapText(text, n)` |
| priority: `level × 100000 + count`, descending | `prepare` (`model.order`) |
| placement on rings of 16 directions, shrink by 0.88, drop below the minimum size | `layout(model, opts)` |
| the order names are drawn in | `drawOrder(placed)` |
| colours, strokes and the halo | `palette(scheme)` |
| the density grid and its three box blurs; marching squares | `densityGrid`, `contourSegs`, `gridScale`, `zoneAlpha`, `zoneShapes` |
| the dots' radius | `dotRadius(model, frame)` |
| the line of counts under the map | `caption(frame)` |

The arithmetic is kept in the order the rules were first written in, so the
same document, spreads and widths give the same values to the last bit
(`test/dense.test.js`). The zone tint is a colour string (`oklch(…)`); the code
that draws it resolves it to sRGB with a canvas.

The recorded drawing computed spreads around anchors before rounding those
anchors for its document. `prepare` normally computes spreads from the anchors
it receives. Reproducing that recording exactly therefore also requires its
spreads: pass `{ spread: { topicId: radius } }` as the third argument. On the
reference document, 28 of 143 labelled topics differ by 0.001 when spreads are
recomputed; none changes placement there. Such a difference can add or remove
a spiral ring and change placement on another document. It is not a general
placement tolerance.

## The highlights: `highlights.js`

`PolisTopicMapHighlights` chooses the comments a page brings forward over the
map: the comments that stand out on the whole map as most consensus or most
divisive, the map's top few and each topic's own, with each topic's summaries
sorted highest consensus first and the topics that stand out as topics
marked. It draws nothing and measures nothing new: it takes numbers Polis
already computes, keyed by comment id (the document's point id).

```js
var numbers = PolisTopicMapHighlights.numbersFrom(math, comments);
// math: the math result (GET /api/v3/math/pca2); comments: GET /api/v3/comments
var h = PolisTopicMapHighlights.highlights(doc, numbers, { n: 5, perTopic: 1, minVotes: 5, level: 0, standout: 0.9 });
```

| Number | What it is | Where Polis computes it |
| --- | --- | --- |
| `consensus` | group-informed consensus as the report shows it: the mean over the opinion groups of (agrees + 1) / (agrees + disagrees + 2); 1 when every group agrees | `client-report/src/util/normalizeConsensus.js`, from the math result's `group-votes` |
| `divisive` | the comment's extremity: the length of its projection on the two principal components; the axis of the report's "How divisive was the conversation?" chart | the math result's `pca["comment-extremity"]` (`delphi/polismath/pca_kmeans_rep/pca.py`, `compute_comment_extremity`) |
| `votes` | agree + disagree + pass | the comments route's counts |

Either measure can be replaced by any other number per comment, for example the
math result's `group-aware-consensus` (the product over groups, which the math
engine stores).

- **Eligible:** a point with an id (held-back points are never chosen), a finite
  value for the measure, and at least `minVotes` votes (5, the topic
  statistics page's floor).
- **Order:** most first; ties go to more votes, then to the smaller id.
- **Standouts only:** a comment is brought forward for a measure only when it
  is in the top share of the map's eligible comments for that measure
  (`standout`, default 0.9: the top tenth). The line is the value of the k-th
  comment in order, k = ceil(count × (1 − standout)); every eligible comment at
  or above it is a standout, so ties at the line are all in. The map's `n` and
  each topic's `perTopic` picks come from the standouts only: a topic with no
  standout has no pick; nothing is forced. `standout: 0` makes every eligible
  comment a standout.
- **Each topic** of `level` gets its `perTopic` standouts per measure, all its
  standouts (`standouts.consensus`, `standouts.divisive`, most first), and a
  summary of its eligible comments' consensus (`summary`) and divisiveness
  (`divisiveSummary`): `count`, `min`, `q1`, `median`, `q3`, `max`; quartiles
  by the linear interpolation of plotly.js's box trace, which draws the topic
  statistics page, at position p × n − 0.5. Topics are sorted by median
  consensus, then upper quartile, then count, then their order in the
  document; a topic with no eligible comment comes last, with `summary: null`.
- **Special topics** (`special.consensus`, `special.divisive` on each topic):
  over the topics with a summary, a topic is special for consensus when its
  median consensus is in the top share of the topics' medians (`topicStandout`,
  default 0.85, by the same k-th rule) and its spread q3 − q1 is at or under
  the `spreadQuantile` quantile of the topics' spreads (default 0.25, the
  narrowest quarter); special for division when its median divisiveness is in
  the top share of the topics' medians of that measure (`topicDivisive`,
  default 0.9).
- **Returns** `{ settings, eligible, standout, special, consensus, divisive,
  topics }`; `standout` gives each measure's `line` and `count`, `special` each
  rule's lines and how many topics it marks; each chosen comment is
  `{ index, id, x, y, value, votes, topic }`, where `index` is the point's
  place in the document and `topic` the id of its topic at `level`, or `null`.

## Taking it into a client

Code is shared between the clients today in two ways. Build tooling lives in the
repository's `scripts/` folder, beside the clients: each client's build
configuration reaches it by a relative path (`../scripts/…`), and each
Dockerfile copies the files it needs to the same place beside the client. The
client error reporter, the one piece of browser code the clients share, is
copied into each client byte for byte, and a test keeps the copies identical.
This package follows the first way: one folder beside the clients, reached by a
relative path, copied beside the client in its Docker build. No client needs a
new dependency.

What each client's build does with it, as tried on each one's own build:

- **The report and the admin** (webpack 5): the scripts by default import,
  ```js
  import PolisTopicMap from "../../client-topic-map/topic-map.js"; // the path from the importing file
  import PolisTopicList from "../../client-topic-map/topic-list.js";
  import neutral from "../../client-topic-map/theme-neutral.js";
  ```
  The report also takes `import "…/client-topic-map/fonts/roboto.css"`:
  its css-loader emits the font file beside the bundle with a hashed name. The
  nginx configuration routes only known paths of the report's build, so the
  report would give the font a path that is routed (under `/fonts/` or
  `/static/`) and a `.headersJson` file, as it does for its other files. The admin cannot import a style sheet today (its
  CSS rule names `style-loader` and `css-loader`, and neither is installed); it
  would copy `fonts/` into its build and link `roboto.css` from its page, as it
  does for its own font, Space Mono.
- **The participation client** (Astro, Vite): Vite does not read CommonJS
  exports from a file outside `node_modules`, so a default import fails its
  build. It takes the scripts as plain scripts and reads the names they define:
  ```js
  import "../../../client-topic-map/theme-neutral.js";
  import "../../../client-topic-map/topic-map.js";
  import "../../../client-topic-map/fonts/roboto.css";
  const { PolisTopicMap, POLIS_TOPIC_MAP_THEME_NEUTRAL } = globalThis;
  ```
  Its build emits the font under `/_astro/`. This works in `astro build` and
  `astro dev` with no change to its configuration.
- **Their Docker builds** copy only the client's own folder and the named
  scripts, so each one taking the package adds one line that copies
  `client-topic-map/` beside the client folder: `/client-topic-map/` in the
  stages of `file-server/Dockerfile` and in `client-participation-alpha/Dockerfile`
  (where the client is at `/app`), and `/app/client-topic-map/` in
  `client-report/Dockerfile` and `client-admin/Dockerfile` (where it is at
  `/app/<client>`).

### Zoom steps: names stay waypoints

Zoomed in (any view closer than the fit; at the fit and zoomed out nothing
changes), the dense drawing names one layer at a time, set by
`zoom.steps` (multiples of the fit, preset `[1.5, 3, 6]`): below the first
step every layer is placed as at rest; from `steps[i]` the next finer layer
is the focus; past the finest layer, comment labels are (only when the
document has text, or the drawing has a list of comments to bring forward,
`comments.only`, as the deepest zoom's overlay gives it even when none of
them stands out or has text, and the points in view pass `comments.maxPoints` and
`comments.minSpacing`; otherwise the finest layer stays the focus). Zoomed in,
no name is shrunk to fit, so none is drawn smaller than at rest; the focus
layer and those above it are drawn at least `zoom.focusSize` (`[13, 17]` px,
by count) and never under `zoom.floor` (11 px). The coarser layers step back
to waypoints: the topics holding the most points in view, nearest layer
first, drawn first at `zoom.waypointAlpha` (0.62) and held at the view's edge
when their anchor has left it (`held: true` on the name). The focus names
the finer topics of the nearest waypoint first. Budgets (`zoom.budget`, by
role): `district` 5, `finest` 6, `comments` 5, `waypoints` 2; so a view shows
at most 2 waypoints and 6 focus names, or 2 waypoints and 5 comment labels.
Names placed zoomed in carry `role` (`waypoint`, `focus`, `overview`);
`densestats` carries `stage` and `focus`. `zoom.steps: false` places names
and comments as before the steps (every layer, comments whenever the points
in view allow, no budget). Zoomed in on the light ground, a zone whose hue is
between 15 and 130 (OKLCH), whose pale tint reads cream or beige, is tinted a
cool neutral (`oklch(0.80 0.02 250)`); its outline and names keep the hue.

### The surface follows the room there is

One rule for every size of conversation, not a preset for small ones.

- **Names.** `room` (in `PRESET_DENSE`: `area` 40000, `grow` 1.4, `maxPx` 36,
  `spread` 0.6): with more than `area` px² of map per name drawn, every name
  grows by sqrt(area per name / area), at most `grow` times, at most `maxPx`
  and at most `spread` times its topic's spread on screen at the fit, never
  under its size at rest; the same growth at every zoom. A document of one
  level gets the zone's sizes, wrap and capitals (where roles fall on one
  level, the zone's value keeps it). A map with as many names as the
  reference has no room: nothing grows (`frame.stats.grow` is 1).
- **Comments at the surface.** `zoom.surface` (`minAreaPerPoint` 6000,
  `areaPerComment` 120000, `max` 10, `reach` 180, `gap` 8, `minInView` 8;
  `false` turns it off) applies when the drawing has a list of comments to
  bring forward (`zoom.comments.only`, the deepest zoom's standouts) and the
  steps are on. In a view with at least `minAreaPerPoint` px² per point in
  it, one comment is written out per `areaPerComment` px² of the map not
  taken by names, at most `max`, at the whole-map view and at every step
  (at the deepest step, at least the comment budget). With
  `zoom.comments.kinds` beside `only`, each kind gets half the budget first.
  Each label is placed beside its dot, never over it: its box covers no dot,
  name or other label; a leader from the dot to the box's nearest edge
  (`leader: [x0, y0, x1, y1]` on the label) is kept off every name and label;
  the deepest zoom's overlay draws the leader and rings the dot in the kind's
  colour. `densecomments` then has `on` and `surface` true and `budget`.
- **Targets.** Where the overlay is on (`densecomments.detail.on`), the
  pointer picks the comment nearest it within `reach` (40) px, the comments'
  Voronoi cells cut at that distance: a written-out comment answers by its
  text and graphic, a lead by its words, every other comment by its cell.
  Further than 40 px from every comment nothing is picked and a click clears
  the selection. The picked dot is ringed. The comments in view are put on a
  grid of 40 px cells once per settled view, so a pointer move reads nine
  cells (`pointIndex`, `nearestPoint`). Where the view is too crowded for the
  overlay (Bowling Green's whole map) the map's own tooltip answers, within
  a dot's radius (`hitRadiusMin`).
- **Leads.** At the deepest step (`densecomments.detail.deep`), every other
  comment in view with text gets its first words beside its dot (`lead`:
  at most 5 words and 30 characters on one line, cut with "…", 12 px,
  weight 400, `#6f7682` over a white halo), most votes first; a lead is
  never over another lead, a written-out comment, its rule, graphic or
  leader, a name or another comment's dot, and with no free place it is
  left out, so the fewest votes go first. At the surface there are none.
  `lead: false` turns them off.
- **Steps.** A map with that room at the fit (`isSmall`) has one step,
  straight to its comments, and its zoom ends at `zoomLimit`:
  sqrt(points / `minInView`), at least ×2, where on average fewer than
  `minInView` points would be left in view a step further. Other maps keep
  `zoom.steps` and `zoom.max`.

### The grey ground

Topic colour is for orienting in topic space. Whenever comments and their
votes are on the map, the votes are the only colour: the zones' tints, the
zone and district borders, every name (waypoints included) and any coloured
dots turn to neutral greys, and the comments written out turn near-black.

- **When:** the grey ground is on exactly while the view shows comments,
  or comment text is still fading out: `densecomments.detail.on` (a document
  that has comment text, or the deepest zoom's overlay, whose first words and
  count-only cards need no standout),
  that is the comments written out at the whole-map view of a map with room,
  the deepest step of any map (its comments, their first words, a hovered or
  selected comment's card, which show only there), and comment labels zoomed
  in. Where no comment is shown (a crowded map's whole view and its first
  steps) the topics keep their colours exactly as before.
- **The greys** (`PolisTopicMapDense.GREY_GROUND`, OKLCH lightness, chroma 0;
  on the light ground): tints 0.90 (at the tint's alpha, from about `#fafafa`
  to `#f0f0f0` over white), zone borders 0.76, district borders 0.82, names
  0.64 at 14 px and under to 0.76 at 28 px and over, lighter the larger (with their white halo; waypoints keep their 0.62 alpha), coloured
  dots 0.78; grey dots stay `#b4b9c1`; the comments' ink `#1f2329`. Each
  topic colour keeps its hue number and loses its chroma (`towardGrey`).
  `palette(scheme, share)` is the palette at a share of grey; with no share
  it is the palette as before.
- **The votes' colours** are untouched: the vote graphic, the green and red
  rules of group-informed consensus and division, and the rings on their
  dots. The leaders are a grey that recedes (`#9ba1aa`).
- **A clean plate:** on the grey ground each comment written out (its text,
  gap and graphic) has a rectangle of the ground's own colour under it, no
  border or shadow, drawn before the dots, so it never sits on a tint.
- **The change** reaches grey before comments appear and stays grey until
  departing comment text has faded away. It returns to colour over 360 ms,
  eased; at once at the first draw, after
  `settle()` or `resetView()`, and for a reader who asks for less motion.
- **The option `ground`:** `"comments"` (the default) is the rule above;
  `"topics"`, the orienting state, writes no comment out (its zoom has no
  comment stage and no surface) and keeps the topics in colour at every step.

## Tests

```sh
make check-client-topic-map            # Node 24.22.1, as hosted CI runs it
node --test client-topic-map/test/*.test.js
```

- `test/geometry.test.js`: the pure rules. Names wrap exactly as datamapplot
  wrapped them, compared with datamapplot's own label strings for two public
  conversations (199 names); the first view; Web Mercator; the wheel step; label
  sizes; four cases of the rule for which names show.
- `test/api.test.js`: the methods and events above, on the public fixture
  document, with the least of a page the components need to be built (nothing
  is drawn).
- `test/drawing.test.js`: the map's `drawing` option, on a canvas that records
  its calls: the default drawing's calls are the ones it made before the option
  existed; the dense drawing draws a tint and an outline per zone, a dashed
  outline per district, one dot per point (held-back points included) and one
  text draw per placed line, and, measuring with the reference's widths, places
  the reference's names; a document of two levels draws too.
- `test/zoom.test.js`: zoom, pan, hover and click in the dense drawing,
  dispatched as a browser would: at rest its calls are the ones it made before
  it could move; a double-click zooms about the pointer and the names are
  placed again (more of those in view, none whose anchor has left it); a name
  keeps its size in pixels; mid-gesture the last placement is drawn moved and
  is placed again after the settle; the limits and `resetView`; comment labels
  only past the threshold, only for points with text, never for held-back
  points, without overlap, most voted first, more words further in; the
  reserved box; the same events as the default drawing.
- `test/dense.test.js`: the dense drawing's rules against one drawing made in
  a browser at 1408 by 803 px (`fixtures/dense-reference.json`): given that
  drawing's document, its recorded spreads and its measured widths,
  every placed name (its lines, size, weight, position, box, and whether and
  how far it was shrunk), every dropped name, the counts, the caption, the
  zone and district colours and the density grid of one zone (every Float32
  cell, every outline segment) are equal to the recorded values exactly. The
  fixture is a cut of a public conversation's stored map, with names written
  by a language model.
- `test/highlights.test.js`: the choice of comments to bring forward, on
  small made-up documents: the report's consensus formula, extremity by the
  math result's order, the vote floor, held-back points never chosen, the
  order of ties, each topic's comments and summary, the order of topics, and
  the quartile rule.
- `test/surface.test.js`: the surface follows the room: a map with room writes
  its standouts out at the whole-map view within the budget, balanced, beside
  their dots; a crowded map and the reference write none; names grow within
  the bounds; a small map's steps end where nothing new would show.
- `test/nearest-leads.test.js`: the nearest comment within the reach (and
  nothing beyond it), a stable tie, the grid against a scan of 4,000 comments;
  leads only at the deepest step, cut with "…", never over anything, the
  fewest votes left out; the fit of a small map keeps every zone inside the
  frame.
- `test/grey-ground.test.js`: the grey ground is on exactly when comments are
  shown (a map with room at its whole view; a crowded map at rest, off, and
  at its deepest step, on; the topics' ground, off), every fill and stroke
  colour drawn then (and every tint colour resolved) has chroma under 0.025,
  the votes' colours are unchanged, the plates, the fade and its cut.
- `test/self-contained.test.js`: no script or style sheet of the package names a
  URL with a scheme or opens a request, and the style sheet's one URL is the
  font file beside it, the face the neutral theme names.

What the tests cannot see is drawing: pixels and events from a person's pointer
need a browser. The test that the map loads and draws with every non-local host
blocked belongs to the page that shows it.

## Notices

`NOTICE` names what this package is derived from or carries, with each one's
licence: datamapplot, deck.gl and mjolnir.js (MIT), Python's textwrap module
(PSF License), Roboto (SIL Open Font License 1.1, full text in `fonts/OFL.txt`),
and the public fixtures (CC BY 4.0, from `compdemocracy/openData`).

## Reader data and overlay lifetime

The package renders the data the page supplies; it does not authorize a
reader or apply moderation. Pass only the map document and comment text,
counts and measures permitted for the current reader. Never restore an id,
text or topic association to a held-back point by joining a broader comment
list or math result. Preserve the route's neutral topic names and filtered
membership. All parallel point arrays must still describe the same points
in the same order.

A deep-zoom overlay retains its input document, math and numbers. Destroy it
before replacing the map's data with `setData`, changing the run or comment
selection, or changing the reader's permissions; then create a new overlay
from the new authorized inputs. Do not reuse a moderator's document or
associated counts for a public reader.
