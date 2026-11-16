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
| `topic-map.js` | the map | 44,142 |
| `topic-list.js` | the list | 7,976 |
| `theme-neutral.js` | the neutral theme | 5,754 |
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

Methods:

| Method | What it does |
| --- | --- |
| `setData(data)` | draws another document; clears the selection and the hover (without events) and returns to the first view |
| `setTheme(theme)` | draws with another theme |
| `setLevel(level, origin)` | shows another level; dispatches `levelchange` if the level changed. Throws for a level the document does not have |
| `select(id, origin)` | selects a topic, or clears the selection with `null`; dispatches `topicselect` if the selection changed. Throws for an unknown id |
| `hover(id, origin)` | marks a topic as hovered, or none with `null`; dispatches `topichover` if it changed. Throws for an unknown id |
| `setCollision(mode)` | `"as-drawn"` or `"by-weight"`, as the option |
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
