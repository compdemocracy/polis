# Comment statistics

Which comments divided the room the most?

```sh
polis comment stats --conversation CONV
polis comment stats --conversation CONV --sort disagree
polis comment stats --conversation CONV --sort consensus --by-group --json
```

The command reads the served `math/pca2` presentation, participant-visible
comment pages, then current importance counts. It never requests computation.
The ranking covers the complete text list, bounded to 10,000 rows. Comments
absent from those pages are excluded; newly visible comments absent from math
have unknown statistics. This is a descriptive summary of **grouped participants**,
not a count of everyone, a freshness claim, or a test of statistical significance.
Math and current importance are different observations. Each text page is another
read; concurrent moderation can change visibility. Duplicate IDs or incomplete
pagination fail without a partial ranking.

| Field | Definition |
| --- | --- |
| `votes` | Sum of `S` (seen) over every group for this comment |
| `agree`, `disagree` | Sum of `A`, `D` |
| `pass` | `votes - agree - disagree`; `S` already includes pass |
| `agree_pct`, `disagree_pct`, `pass_pct` | 100 times the corresponding count divided by `votes` |
| `divisiveness` | `1 - abs(agree - disagree) / (agree + disagree)`; 1 means evenly split, 0 means one-sided |
| `consensus` | Minimum agree percentage across all groups; ranges from 0 to 100 |
| `important` | Current importance-read count, when that comment is present in that read |
| `groups` | Only with `--by-group`: stored group ID and the same counts, percentages and divisiveness for that group |

Consensus here means support across groups, not the engine's differently defined
consensus score. Pass votes reduce agree percentages. A missing tally in any
group makes the total and consensus unknown; a missing group is never silently
counted as zero. Zero seen votes make percentages unknown. No agree/disagree votes
make divisiveness unknown. A group with zero seen votes makes consensus unknown.
Unknown values are JSON null and `-` in the terminal. Small samples can rank
highly; inspect counts and group splits before drawing conclusions.

Sort keys are `agree`, `disagree`, `pass` (percentages), `divisive` (the default),
`consensus`, `important`, and `votes`. All descend, with unknowns last and numeric
comment ID ascending on ties. Missing importance fields are omitted, not zero.
An unavailable importance read emits a stderr note and a structured note;
`--sort important` instead fails with exit 8. Invalid successful importance
contracts fail, rather than rank unvalidated values. Zero importance is a real
observed zero. Importance is from latest votes on currently participant-visible
comments, not the served math's historical input or a count of verified people.

## JSON envelope and source bytes

`--json` uses the standard `polis-cli/1` envelope (`ok`, `site`, `data`, `meta`,
`warnings`). `data` has:

- `schema: "comment-stats/1"`, `conversation_id`, `math_tick`;
- `sort`, `order: "descending_unknown_last_tid_ascending"`;
- `comments`: ranked rows with `tid`, full `text`, and fields above;
- `importance`: `state` (`observed` or `unavailable`) and `read_at_ms` (null if unavailable);
- `notes`: scope, uncertainty, and capability notes;
- `reads`: successful source reads in request order, each with `path`, `query`
  (ordered pairs), and `body`.

`reads[].body` is an exact UTF-8 **string** containing the decoded source JSON:
whitespace, member order, extensions and number spellings are retained. Parse
the outer envelope, then UTF-8 encode the string to recover those body bytes;
parse the string separately to inspect the source data. JSON escapes for terminal
controls preserve decoded bytes. HTTP headers and compressed transport bytes
are not archived. Computed numeric fields are derived JSON, not a claim to
reproduce a server's calculations. Text is shortened only in the human table.

Every response uses the existing 8 MiB body bound and `--timeout`; at most
1,000 groups, 10,000 distinct math comment IDs, 10,000 text rows, and 32 MiB
of combined successful source bodies are accepted. The comment-by-group product
is bounded to 100,000 cells, even when per-group display is off. Text pages contain at most
500 rows. Reads are sequential with no retry. Exceeding a bound, invalid counts,
or malformed pages prints no partial ranking. No database writer, vote-sign
conversion, route, pool, or production switch is changed by this command.
