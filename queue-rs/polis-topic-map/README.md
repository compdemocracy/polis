# polis-topic-map: the data behind the first-party topic map

The topic map shows a conversation's comments placed by what they say (each
comment's UMAP position from a Delphi run), grouped into topics at several
levels (EVoC clusters), with each topic's name. Today the Delphi pipeline draws
it with the Python library datamapplot, as one HTML page per level. This crate
is the first half of a replacement: it computes, once per run, everything about
the map that depends only on the run, and writes it as one JSON document that a
browser component draws. Nothing in Polis calls it yet: it adds no route, no
pipeline stage and no stored data.

## What it reads

The three things a Delphi run stores for the map, in the JSON shapes two
existing server routes return them in (only the shapes: the crate reads files
or values it is given, never a route):

- `GET /api/v3/topicMod/proximity?layer_id=all`: for every comment, its id, its
  UMAP position (x, y) and its cluster at every layer (-1 for none).
- `GET /api/v3/delphi`: the topic names of each run, by layer and cluster. When
  there are several runs, the newest (by `created_at`) is used, as the report
  does.
- Optionally, the comment texts, as a JSON object of comment id to text.

## What it writes

One document, schema `polis-topic-map/1`:

- `schema`, `title`, `attribution`, and `run` (the run's job id, topic model and
  time).
- `bounds`: the box the first view is fitted to, and `pointRadius`: the size of
  every point.
- `levels`: for each level, how many topics it has, how many comments are in no
  topic, and which of datamapplot's two palettes it uses (the one built on the
  colour map CET-C2s when a level has more than 50 labels, counting the comments
  in no topic as one, which is Delphi's rule).
- `topics`: for every topic at every level, its id (`level_cluster`), name, how
  many comments it holds, where its label sits and how much it weighs (the
  fourth root of the count), the coarser topic that holds most of its comments
  and what share that is, and its colours: the topic colour and the darker label
  colour, once for its own level's map and once for a map of every level
  together.
- `points`: for every comment, its id, its position on the map, its topic at
  every level (an index into `topics`, or -1) and its hover text
  (`Comment <id>: <text>`, with the text empty when none was given).

The rules for the map's standard size, the first view, the point radius, the
label positions and weights, and both palettes are ported from datamapplot
0.6.4, including two slips in its angle window that decide the colours maps have
today (`src/palette.rs` says which). The colour space is CIECAM02, written from
the published model (`src/ciecam02.rs`). What the browser does with the document
(projection to pixels, label sizes and wrapping, which labels give way to which)
is not in this crate.

## As a library

```rust
let data: polis_topic_map::MapData =
    polis_topic_map::build(proximity, topics, &comments, title, attribution)?;
let json = serde_json::to_string(&data)?;
```

`build` takes the two route bodies (`Proximity`, `Topics`), the comment texts
(`BTreeMap<String, String>`, comment id to text; empty for none), a title and an
attribution, and returns the document or a message saying why it could not (no
positions, no topic names, no cluster layers).

## As a command

```sh
polis-topic-map data --proximity FILE --topics FILE [--comments FILE] \
  --title TEXT [--attribution TEXT] --out FILE
polis-topic-map page --template FILE --out FILE \
  [--text NAME=FILE]... [--script NAME=FILE]... [--base64 NAME=FILE]...
```

`data` writes the document. `page` fills each `{{{NAME}}}` slot of an HTML
template with a file's text (`--text`), with a file's text made safe inside a
script element (`--script`), or with a file's bytes in base64 (`--base64`), to
make a page that fetches nothing. No template is in this crate.

## Tests

From the repository root, formatting, clippy and every test, as hosted CI runs
them:

```sh
make check-polis-topic-map
```

or only the tests, from `queue-rs/`:

```sh
cargo test --locked -p polis-topic-map
```

They need the pinned Rust toolchain and nothing else: no database, no network,
no Docker.

- `tests/datamapplot_parity.rs` holds the port to what datamapplot 0.6.4 itself
  computed for the same runs (`tests/fixtures/<set>/expected.json`): the colour
  space against colorspacious (to 1e-9 from JCh to sRGB, 1e-7 back); the
  standard size, the first view and the
  point radius; the position, weight and both colours of every label of every
  level; the map of every level together, point by point; and that the document
  holds every comment and a tree.
- `tests/document_recording.rs` holds the whole document to a recorded length
  and SHA-256 for each fixture, from the library and from the command. The
  recorded values are what the prototype this crate came from wrote for the same
  inputs.

## The public fixtures

`tests/fixtures/bg2050` and `tests/fixtures/biodiversity` are a Delphi run over
two public conversations from `compdemocracy/openData` (CC BY 4.0):
`bg2050-volunteers` (3,948 comments, four levels) and
`scoop-hivemind.biodiversity` (154 comments, two levels). Each has
`proximity.json` and `topics.json` (the run, in the two routes' shapes) and
`expected.json` (datamapplot's own values). They hold comment ids, positions,
clusters and topic names; no comment text and no vote. The topic names were
written by a small local model (qwen2.5:1.5b) and are not the names pol.is
shows. Licences and attributions: `NOTICE`.
