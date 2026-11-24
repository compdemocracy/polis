# Topic naming fixtures: Bowling Green 2050

Test data for `delphi/tests/test_topic_namer.py`, the naming step for a run
whose job names a model to write its topic names. All of it is public.

- **Source.** The public Polis conversation Bowling Green 2050, published in
  [compdemocracy/openData](https://github.com/compdemocracy/openData) as
  `bg2050-volunteers` (CC BY 4.0). The layout (comment positions in the 2D
  map and the four cluster layers) is the topic map's own Bowling Green
  fixture, `queue-rs/polis-topic-map/tests/fixtures/bg2050/proximity.json`.
  Comment text is the `comment-body` column of openData's `comments.csv`,
  keyed by its `comment-id`, with runs of whitespace collapsed to one space.
- **`bg2050_layout.json`**: that layout, compacted: comment ids in comment
  order, `x` and `y`, and one cluster array per layer (`-1` is noise).
  Comments that are noise in every layer are left out; they belong to no topic.
- **`bg2050_hierarchy.json`**: the hierarchy a study of whole-hierarchy topic
  naming (November 2026) built for this conversation and sent to the models,
  in the shape the step writes (`polis-topic-names.hierarchy/1`): every
  non-noise topic of every layer, its size, its parent (the topic one layer
  up holding most of its non-noise comments), its five keywords and the three
  comments nearest its centre in the 2D map. The step must build exactly this
  from the layout.
- **`bg2050_sample_comments.json`**: the text of the 459 comments that appear
  as samples in that hierarchy (comment id to text); no other comment's text.
  None of them was moderated out.
- **`bg2050_names_haiku.json`**: the names one saved whole-hierarchy reply from
  `claude-haiku-5-5` gave these 185 topics in that study, with the reply's
  token counts. The tests use it as what the program would have written; no
  test makes a model call.

No author, participant, vote or time is in any of these files.
