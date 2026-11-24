# polis-topic-names: one model call that names a Delphi run's topics

A Delphi run groups a conversation's comments into topics, in layers (EVoC
clusters over the UMAP layout). Today each topic is labelled by its keywords.
This crate is the typed place where a model call for better names lives: given
the whole topic hierarchy, it asks one model (Claude Haiku 5.5 or Claude
Sonnet 5.5) to name every topic in one call, checks the reply, and writes the
names, or the reason it could not, to a file.

**Nothing in Polis calls it yet.** It adds no route, no pipeline step, no
setting and no stored data. A later change to the Delphi pipeline will run it
as a subprocess, the way the pipeline runs `polis-topic-map`.

## How it is run

```
polis-topic-names name --in hierarchy.json --out names.json \
  --namer '{"model":"claude-haiku-5-5","prompt":"polis-topic-names/1","thinking":"default"}'
```

- `--namer`: `model` is `claude-haiku-5-5` or `claude-sonnet-5-5`; `prompt` is
  `polis-topic-names/1`; `thinking` is `default` (no thinking field is sent) or
  `off` (Haiku `{"type": "disabled"}`, Sonnet `{"type": "between_tools"}`). An
  optional `"by": "model"` is accepted. Anything else is refused.
- The key is read from `DELPHI_NAMING_ANTHROPIC_API_KEY`, and only from there.
  The program never prints it or writes it anywhere.
- The per-run cap, in dollars, is read from `DELPHI_NAMING_RUN_MAX_USD` (0.50
  when unset).
- `--api-base <url>` points the call somewhere other than
  `https://api.anthropic.com/v1`. It exists for the offline tests.

Exit status: **0** when `names.json` was written, whatever the outcome (a
failed model call is an outcome, not an error); **2** for a usage error; **1**
when `hierarchy.json` cannot be read or checked, or `names.json` cannot be
written. On 1 or 2 nothing is written.

## What it reads: `hierarchy.json`

```json
{"schema": "polis-topic-names.hierarchy/1",
 "topics": {"0_0": {"id": "0_0", "layer": 0, "cluster": 0, "size": 12,
                    "parent": "1_3", "keywords": ["…"], "samples3": ["…"]}}}
```

Every topic's id is `<layer>_<cluster>`, and its parent, when it has one, is a
topic one layer up. Other fields are ignored.

## What leaves the network

One HTTPS request to the Messages API per run, plus at most one retry. Its body
holds, for every topic: its id, layer, parent's id, number of comments, at most
five keywords and at most three sample comments (their text only), and the
instruction. Nothing about authors or participants, no comment id, vote or
time, and no conversation title, description or code. The headers are
`content-type`, `anthropic-version`, `x-api-key` and those the HTTP client
adds; none names the project. The caller chooses which comments are samples;
the plan is that they are only comments participants are shown.

## The request

Prompt version 1 is the instruction, topic lines, JSON schema and body layout
of a measured whole-hierarchy call, byte for byte (a test compares the body
with the body that was sent), with one sentence added after "No two topics may
share a name.":

> Write every name in the language most of these comments are written in.

`max_tokens` is 32,000. The reply is a JSON object `{"topics": [{"id", "name"}]}`
(the request's `output_config.format`).

## Outcomes

`names.json` holds `schema` (`polis-topic-names.names/1`), `outcome`,
`reason` (null when named), `names` (id to name, only when named) and
`record` (model, prompt, thinking, tokens in and out, dollars, the namer word,
attempts, HTTP status, stop reason, the worst-case estimate and the cap).

| outcome | when | calls made |
|---|---|---|
| `named` | every check passed | 1 or 2 |
| `too_large` | more than 400 topics, or more than 120,000 counted input tokens | 0 |
| `over_run_cap` | the worst case passes the cap, or the cap setting is unreadable | 0 |
| `no_key` | no key in the environment | 0 |
| `http_<status>` | any status but 200 (after the retry, for a retried status) | 1 or 2 |
| `timeout` | no complete reply within 300 s | 1 |
| `connect_error` | no connection, twice | 2 |
| `refused` | stop reason `refusal` | 1 or 2 |
| `truncated` | stop reason `max_tokens` | 1 or 2 |
| `bad_json` | the reply is not the schema's shape, or another stop reason | 1 or 2 |
| `bad_cover` | a topic missing, an unknown id, or an id twice | 1 or 2 |
| `wrong_language` | the names are not in the comments' script or language, or are mis-encoded | 1 or 2 |
| `bad_length` | a name empty or over 50 characters after cleaning | 1 or 2 |
| `repeated_names` | two topics of one layer with the same name | 1 or 2 |

The checks run in the order of the table's last seven rows; the first that fails
is the outcome, and the whole reply falls back (a map never mixes model names
with keyword names).

**The one retry** follows HTTP 429, 500, 502, 503, 504 or 529, or a failed
connection, after the reply's `retry-after` (at most 60 s), else 10 s.

**The cost check.** Before any call: the request body's characters (one token
per character is an upper bound for every script measured) at the model's
input price, plus 32,000 output tokens at its output price. Prices, per
million tokens: Haiku 5.5 $0.10 in, $0.50 out ($0.50 and $2.50 above 100,000
prompt tokens); Sonnet 5.5 $2 in, $10 out. A model not in the table is refused.

**The language check.** The code names no language; the model decides from the
comments. For the check only, the comments' majority script is counted over
the samples sent (Han, Kana, Hangul, Arabic, Cyrillic, Devanagari, Hebrew,
Thai, Greek, Latin). When it is not Latin, more than one name in five with no
letter in that script fails. When it is Latin and a rough function-word rule
says most comments are German, Spanish, Portuguese or French, more than one
name in five that looks English (an English function word and no mark of the
comments' language) fails. Any name holding a C1 control character, or two
Cyrillic letters in a row when no comment sent holds one, fails.

## Tests

All offline: every model call goes to a local HTTP stub on 127.0.0.1. The
fixtures are described in `tests/fixtures/README.md`.

- `request_body`: the body equals the saved body of two measured calls plus the
  sentence; what reaches the stub is that body, with only the named headers.
- `saved_replies`: all 36 saved whole-hierarchy replies parse and cover every
  topic; vTaiwan's Haiku replies and one Mobilität Haiku reply (names in
  English) are `wrong_language`, the rest are `named`; a mis-encoded Urdu reply
  is `wrong_language`.
- `outcomes`: every other outcome, with the number of calls each makes.
- `program`: argv, environment, exit status and `names.json`.

Run them with `make check-polis-topic-names` (format, clippy, tests).
