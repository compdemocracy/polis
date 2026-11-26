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
- `provider` (optional): `anthropic`, the default when absent, sends the call
  to the Claude API; `bedrock` sends it to Claude in Amazon Bedrock (below).
  The namer word gains a `bedrock.` prefix through Bedrock
  (`bedrock.claude-sonnet-5-5.p1.default`); without the field every word,
  body and file is what it was before the field existed.
- The key is read from `DELPHI_NAMING_ANTHROPIC_API_KEY`, and only from there,
  and only for the Claude API. The program never prints it or writes it
  anywhere.
- The per-run cap, in dollars, is read from `DELPHI_NAMING_RUN_MAX_USD` (0.50
  when unset).
- `--api-base <url>` points the call somewhere other than
  `https://api.anthropic.com/v1`. It exists for the offline tests.

Exit status: **0** when `names.json` was written, whatever the outcome (a
failed model call is an outcome, not an error); **2** for a usage error; **1**
when `hierarchy.json` cannot be read or checked, or `names.json` cannot be
written. On 1 or 2 nothing is written.

## Through Amazon Bedrock

With `"provider": "bedrock"` the call goes to the Messages API of Claude in
Amazon Bedrock, `https://bedrock-mantle.<region>.api.aws/anthropic/v1/messages`.

- **Settings it reads** (names only): `AWS_REGION` (the region, for example
  `us-east-1`; unset, or not a region name, is the outcome `no_region`), the
  per-run cap `DELPHI_NAMING_RUN_MAX_USD`, and whatever the default AWS
  credential chain reads. No key: `DELPHI_NAMING_ANTHROPIC_API_KEY` is not
  read.
- **Credentials** come from the default AWS credential chain when the call is
  made: the environment, the shared profile files, the container's
  credentials, then the instance role through the instance metadata service.
  On a production box that is the instance role. They are held in memory for
  the call's attempts and never written, printed or logged. Single sign-on and
  credential processes are not compiled in.
- **The request** is the Claude API's request byte for byte, with one
  difference: the body's `model` is Bedrock's id for the same model
  (`anthropic.claude-sonnet-5-5`, `anthropic.claude-haiku-5-5`). The headers
  are `content-type`, `anthropic-version` and the AWS Signature Version 4
  headers (`authorization`, `x-amz-date`, and `x-amz-security-token` with
  temporary credentials), signed for the service `bedrock-mantle` in the
  region; `x-api-key` is never sent.
- **Where the text goes.** The comment text of the sample comments (the
  comments participants are shown) leaves the box to Amazon Bedrock in that
  region, over TLS. Nothing goes to the Claude API.
- **Price.** AWS's pricing page showed no price for these models when this was
  written. Anthropic's page says a regional endpoint costs 10 percent more
  than the global one, and AWS's says `bedrock-mantle` does not route across
  regions, so the cost check uses the Claude API's prices plus 10 percent as
  an estimate (Sonnet 5.5 $2.20 in, $11 out per million; Haiku 5.5 $0.11 in,
  $0.55 out, $0.55 and $2.75 above 100,000 prompt tokens). Bowling Green's
  Sonnet worst case is then over the $0.50 default cap, so a Bedrock Sonnet run
  of a conversation that size needs a higher cap.
- **Outcomes** are the Claude API's, plus `no_region` and `no_credentials` (the
  chain gave none within 30 s, or they could not sign the request), both with
  no call made. HTTP 403 (model access not granted, or the role may not call
  `bedrock-mantle:CreateInference`) is `http_403`, not retried; 429, the
  timeout, a refusal and every reply check end as they do for the Claude API.

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
| `no_region` | Bedrock: `AWS_REGION` unset or not a region name | 0 |
| `no_credentials` | Bedrock: no credentials from the chain, or none that can sign | 0 |
| `http_<status>` | any status but 200 (after the retry, for a retried status) | 1 or 2 |
| `timeout` | no complete reply within 300 s | 1 |
| `connect_error` | no connection after the permitted attempts | 1 or 2 |
| `refused` | stop reason `refusal` | 1 or 2 |
| `truncated` | stop reason `max_tokens` | 1 or 2 |
| `bad_json` | the reply is not the schema's shape, has invalid usage counts, is over 4 MiB, or has another stop reason | 1 or 2 |
| `bad_cover` | a topic missing, an unknown id, or an id twice | 1 or 2 |
| `wrong_language` | the names are not in the comments' script or language, are mis-encoded, or hold control characters | 1 or 2 |
| `bad_length` | a name empty or over 50 characters after cleaning | 1 or 2 |
| `repeated_names` | two topics of one layer with the same name | 1 or 2 |

The checks run in the order of the table's last seven rows; the first that fails
is the outcome, and the whole reply falls back (a map never mixes model names
with keyword names).

**The one retry** follows HTTP 429, 500, 502, 503, 504 or 529, or a failed
connection, after the reply's `retry-after` (at most 60 s), else 10 s.
A second attempt is permitted only when twice the per-attempt estimate fits
the run cap; otherwise the first failure is returned without retrying.

**The cost check.** Before any call, the worst case is the counted input
tokens at the model's input price plus 32,000 output tokens at its output
price. Prices, per million tokens: Haiku 5.5 $0.10 in, $0.50 out ($0.50 and
$2.50 above 100,000 prompt tokens); Sonnet 5.5 $2 in, $10 out. A model not in
the table is refused.

The counted input tokens are the request body's length in UTF-8 bytes, which
is a conservative estimate under the following tokenizer and framing assumptions:

- A tokenizer in which every token stands for at least one byte of UTF-8
  text turns n bytes into at most n tokens. That is the bound's one
  assumption about the provider (a byte-level tokenizer has it). A
  count of characters is not a bound: one character is one to four bytes, and
  a character outside the tokenizer's common vocabulary can be up to four
  tokens. vTaiwan's samples are Han characters of three bytes each, so the
  bytes count each such character as three tokens where characters counted
  one.
- The body holds every byte of the prompt text (the JSON writes non-ASCII as
  UTF-8, and an escape such as `\n` only adds bytes), plus the body's own
  JSON: model, max_tokens, thinking, the message's role and quotes. The
  estimate assumes the provider's framing of one user message fits within
  the allowance supplied by the body's own JSON (1,204 bytes for Bowling Green: a 70,540-byte
  body around 69,336 bytes of prompt).
- Recorded against it: Bowling Green's calls reported 25,444 to 25,445 input
  tokens for that 70,540-byte body, 2.8 bytes a token.

So Bowling Green's worst case is 70,540 x $0.10 / 1M + 32,000 x $0.50 / 1M
= $0.0231 on Haiku and 70,540 x $2 / 1M + 32,000 x $10 / 1M = $0.4611 on
Sonnet, both under the $0.50 default. This estimate is for one attempt.
The run reserves another full estimate before allowing a retry, including
when the first attempt has unknown usage. Sonnet does not retry under the
default cap: its output allowance alone is $0.32 per attempt. A caller can
explicitly raise the cap to allow two attempts. This bounds admitted attempts
under the stated tokenization and price assumptions, not a provider invoice.

**The language check.** The code names no language; the model decides from the
comments. For the check only, the comments' majority script is counted over
the samples sent (Han, Kana, Hangul, Arabic, Cyrillic, Devanagari, Hebrew,
Thai, Greek, Latin). When it is not Latin, more than one name in five with no
letter in that script fails. When it is Latin and a rough function-word rule
says most comments are German, Spanish, Portuguese or French, more than one
name in five that looks English (an English function word and no mark of the
comments' language) fails. Any name holding a C1 control character, or two
Cyrillic letters in a row when no comment sent holds one, fails; so does any
name holding another control character or an invisible formatting character
(bidirectional controls, zero-width space, byte-order mark, tag characters).

**What the reply can put in `names.json` and the log line.** Only the names,
when every check passed (cleaned, 1 to 50 characters, no control
characters), and fixed words: the outcome, a reason of fixed text and counts,
the stop reason when it is one of the provider's known words (any other is
`unknown`), the HTTP status and the usage counts. An error body is never read
past its status, and no other field of a reply is copied anywhere.

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
- `reply_boundary`: replies a provider should never send (usage counts of the
  wrong type or overflowing, an unknown stop reason, control characters in a
  name, an oversize body, invalid UTF-8, an error body): each is an outcome,
  and a marker planted in them reaches neither `names.json` nor the log line.
  The library's own unit tests run the parser over a few thousand random edits
  of a saved reply and random bytes, with the same promise.
- `counted_input`: the counted input is the body's bytes, at least every byte
  of its text plus its JSON, for the fixtures' Chinese and German text and for
  ten other scripts; Bowling Green's recorded input tokens are under it.
- `review_boundaries`: overflowing usage, an unknown stop reason and the byte
  count on vTaiwan's Chinese text.
- `bedrock`: through Bedrock, with made-up credentials: the body is the saved
  body with only the model id changed; the signature is recomputed in the test
  (credential scope `<date>/<region>/bedrock-mantle/aws4_request`, signed
  headers, the body's hash) and equals the one sent; no `x-api-key`; 403, 429
  with and without the retry, the timeout, a refusal, a bad cover, no region,
  credentials that cannot sign, and the cap at the Bedrock price.
- `program_bedrock`: the program with credentials from the environment
  through the default chain, with none (the profile files absent and the
  instance metadata service switched off), and with no region.

Run them with `make check-polis-topic-names` (format, clippy, tests).
