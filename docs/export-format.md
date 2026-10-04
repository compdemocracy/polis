# Export and import file formats: the vote sign

Polis exports a conversation as a set of CSV files, and admins can import votes
from a CSV. This page states the sign every vote value in those files uses, how
the files declare it, and the rule the importer applies.

Format id: **`polis-export/1`**.

## The export convention

Every vote value in an export file, and in the votes-bulk import, uses:

| vote     | value |
|----------|-------|
| agree    | `1`   |
| disagree | `-1`  |
| pass     | `0`   |

This is fixed. It does not depend on how the server stores votes internally
(the database has always stored the opposite sign, agree as `-1`; the export
code converts). If the stored sign ever changes, the export files keep this
convention and these bytes.

Written as a declaration, the convention is:

```
agree=+1;disagree=-1;pass=0;format=polis-export/1
```

## Where the declaration lives

CSV has no header comments, so the CSV files keep their column headers and
bytes exactly as before. The declaration is carried beside them:

- **`summary.csv`** has a last key/value row:

  ```
  vote-convention,agree=+1;disagree=-1;pass=0;format=polis-export/1
  ```

  Every row above it is unchanged and in the same position. Consumers that
  read `summary.csv` by key are unaffected; consumers that read it by line
  number see one more line at the end.

- **`format.json`**, a sidecar served with the other files at
  `/api/v3/reportExport/<report_id>/format.json`. It states the format id,
  the declaration, the vote values, and for each file which columns carry a
  vote value (`vote`), a count of named votes (`count`), an importance flag
  (`flag`) or the declaration itself (`declaration`):

  ```json
  {
    "format": "polis-export/1",
    "vote-convention": "agree=+1;disagree=-1;pass=0;format=polis-export/1",
    "vote": { "agree": 1, "disagree": -1, "pass": 0 },
    "files": { "votes.csv": { "vote": "vote" }, "...": {} },
    "docs": "https://github.com/compdemocracy/polis/blob/edge/docs/export-format.md"
  }
  ```

The report page's "Raw Data Export" section links every file, `format.json`
included. Each file is served from
`/api/v3/reportExport/<report_id>/<file>`; there is no zip bundle, so a
downloader who wants the declaration with the data fetches `format.json` (or
`summary.csv`) along with the CSVs.

The older `/api/v3/dataExport` zip (the Clojure math worker's export) has no
producer since that worker was retired; it is not a source of these files.

## Every file and column

### `summary.csv`

Key/value rows, no header: `topic`, `url`, `voters`, `voters-in-conv`,
`commenters`, `comments`, `groups`, `conversation-description`, then
`vote-convention` (the declaration above). No other row carries a vote value.

### `votes.csv`

One row per vote event: `timestamp`, `datetime`, `comment-id`, `voter-id`,
`vote`, and `important` when importance is enabled.

- `vote`: a vote value in the export convention. A vote stored as NULL is
  written `0`, as it always has been.
- `important` (only when importance is enabled): `1` when the vote was
  marked important, `0` otherwise. An importance flag, not a vote value.

### `participant-votes.csv`

One row per participant: `participant`, `group-id`, `n-comments`, `n-votes`,
`n-agree`, `n-disagree`, then one column per comment.

- `<comment-id>` columns: the participant's latest vote on that comment in
  the export convention; empty when they did not vote on it.
- `n-votes`, `n-agree`, `n-disagree`: counts of votes; no sign involved.

### `participant-importance.csv`

Same layout as `participant-votes.csv` with `n-important` in place of
`n-agree` / `n-disagree`.

- `<comment-id>` columns: `1` when the participant marked the comment
  important, `0` when they voted without marking it, empty when they did not
  vote. These are importance flags, not vote values.
- `n-votes`, `n-important`: counts.

### `comments.csv`

One row per comment: `timestamp`, `datetime`, `comment-id`, `author-id`,
`agrees`, `disagrees`, `moderated`, then `importance` when enabled, then
`comment-body`.

- `agrees`, `disagrees`: counts of agree and disagree votes; no sign involved.
- `importance` (only when importance is enabled, before `comment-body`): the
  number of votes on the comment marked important; no sign involved.

### `comment-groups.csv`

One row per comment: `comment-id`, `comment`, `total-votes`, `total-agrees`,
`total-disagrees`, `total-passes`, then for each opinion group
`group-<letter>-votes`, `group-<letter>-agrees`, `group-<letter>-disagrees`,
`group-<letter>-passes`. All are counts; no sign involved.

### `comment-clusters.csv`

Cluster assignments per comment. No vote values.

### `format.json`

The sidecar described above.

## The import rule (`POST /api/v3/votes-bulk`)

The votes-bulk CSV (`vote_id,user_id,vote_value,timestamp,comment_id`) uses the
export convention for `vote_value`: agree `1`, disagree `-1`, pass `0`. The
importer converts each value to the stored sign through the server's vote
convention module.

A file may declare its sign. The declaration is optional:

- **in the file**, as its first line, before the CSV header:

  ```
  # vote-convention: agree=+1;disagree=-1;pass=0;format=polis-export/1
  ```

  Keys may come in any order; `format` may be omitted. Any other first line
  (including another `#` line) is read as the CSV header, as before.

- **beside the file**, as a `format` field in the request body with the shape
  of `format.json` (an object, or that object as a JSON string). It must carry
  `vote-convention`, `vote`, or both.

The rule:

1. **No declaration**: the file is read in the export convention, exactly as
   before this declaration existed.
2. **A declaration that states the export convention** (and, if it names a
   format, `polis-export/1`): accepted; the file is read in the export
   convention. A first-line declaration is removed before the header is read.
3. **A declaration that states any other convention or format** (for example
   `agree=-1;disagree=+1;pass=0`): refused with
   `polis_err_vote_convention_declaration_mismatch`. The importer never
   converts from a declared sign other than the export convention.
4. **A declaration that cannot be read** (a missing key, an unknown or repeated
   key, a value that is not an integer, values that do not form a convention,
   a `format` that is not JSON): refused with
   `polis_err_vote_convention_declaration_malformed`.

These two codes are the closed set. The route refuses a bad declaration with
HTTP 400 and the code; the import worker checks the stored file's first line
again and fails the job with the same code.
