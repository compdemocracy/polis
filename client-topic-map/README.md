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
| `topic-map.js` | the map | 53,516 |
| `topic-list.js` | the list | 7,976 |
| `theme-neutral.js` | the neutral theme | 5,754 |
| `dense.js` | the dense drawing's rules, as pure functions (the map draws them with `drawing: "dense"`) | 28,596 |
| `vote-graphic.js` | the group vote graphic beside one comment, as pure functions (two forms: four rows, filled; poured) | 18,410 |
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

Methods:

| Method | What it does |
| --- | --- |
| `setData(data)` | draws another document; clears the selection and the hover (without events) and returns to the first view |
| `setTheme(theme)` | draws with another theme |
| `setLevel(level, origin)` | shows another level; dispatches `levelchange` if the level changed. Throws for a level the document does not have |
| `select(id, origin)` | selects a topic, or clears the selection with `null`; dispatches `topicselect` if the selection changed. Throws for an unknown id |
| `hover(id, origin)` | marks a topic as hovered, or none with `null`; dispatches `topichover` if it changed. Throws for an unknown id |
| `setCollision(mode)` | `"as-drawn"` or `"by-weight"`, as the option |
| `setDrawing(settings)` | `null`, `"dense"` or the dense drawing's settings, as the `drawing` option; draws at once |
| `settle()` | finishes at once any work on which names show and draws the result |
| `redraw()` | draws again at the next frame |
| `destroy()` | removes the canvas, the tooltip and every listener |

It also has the properties `level`, `selected`, `hovered`, `collision`,
`projection` and `canvas`, and an optional `onTiming` callback, unset by
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
  with a pad of 3% of the smaller side; `projection`, `level`, `collision`, the
  theme's colours and the document's colours do not apply;
- names are placed again only when the element's size has stopped changing for
  120 ms, and when a face finishes loading;
- there is no hover, click or zoom: the pointer does nothing. The settings
  `hover`, `click` and `zoom` are refused for now;
- each placement dispatches `densestats`, whose `caption` is a line of counts a
  page can show ("Drawn now at 1408 by 803 px: 69 topic names (…).").

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
| `densestats` | map, dense drawing only | `{ caption, width, height, placed, byLayer, dropped, layerTotals, zoneCount, shrunk, shiftMedian, shiftP90 }`: what the dense drawing placed, dispatched each time it places the names (at the first draw, after a resize has settled, when a face loads) |

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
    "text": [ … ]               // what the tooltip shows
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
G.caption(L);                                 // "Each row is a group, A at the top. Agree, disagree, pass: of those who voted. Dotted: did not vote."
```

`groups` is one object per opinion group, in order (A first):
`{ label, agree, disagree, pass, didNotVote, didNotSee }`. The counts are named
counts, never signed vote values. `didNotVote` is the group's members who cast
no vote on the comment; `didNotSee`, when known, is how many of those never saw
it (left out, the remainder is one part). `groupsFromMath(math, tid)` builds
them from the math result: `group-votes[gid].votes[tid]` gives `A` (agrees),
`D` (disagrees) and `S` (votes of any kind, passes included), and
`group-votes[gid]["n-members"]` the group's size; pass is `S - A - D` and did
not vote `n-members - S`. Groups are lettered in order of id.

Two forms, from the same groups into the same box, so a page can toggle
between them with the `form` setting:

- `"rows"` (the default), **four rows, filled**: one row per group, A at the
  top. The whole length of a row is every member of the group. From the left:
  agree, disagree and pass, each a share of those who voted, within the part of
  the row that voted; the rest of the row, those who did not vote, is a light
  tint with light dots. A group with no voters is a row of dots.
- `"poured"`: one column per group, A at the left. The upper bar is every
  member, the votes from the left and the rest dotted; the votes pour down from
  the voted part of the upper bar in an S bend and widen to fill the lower bar,
  where agree, disagree and pass are shares of those who voted across its whole
  width.

Every rectangle `layout` returns is on whole CSS pixels, so its edges land on
device pixels at a ratio of 1 or 2; the segments of a bar meet edge to edge and
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
taller, in the package's face). The colours are the report's agree, disagree
and pass.

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
- `test/dense.test.js`: the dense drawing's rules against one drawing made in
  a browser at 1408 by 803 px (`fixtures/dense-reference.json`): given that
  drawing's document, its recorded spreads and its measured widths,
  every placed name (its lines, size, weight, position, box, and whether and
  how far it was shrunk), every dropped name, the counts, the caption, the
  zone and district colours and the density grid of one zone (every Float32
  cell, every outline segment) are equal to the recorded values exactly. The
  fixture is a cut of a public conversation's stored map, with names written
  by a language model.
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
