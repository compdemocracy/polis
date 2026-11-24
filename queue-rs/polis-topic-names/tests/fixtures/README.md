# Fixtures

Every file here comes from one measurement of topic naming made on 2026-11-22
over three public conversations, each from its public openData export:

- `bg2050`: Bowling Green 2050 (185 topics, English);
- `mobilitaet`: an Austrian conversation on mobility (103 topics, German);
- `vtaiwan`: vTaiwan's conversation on UberX (16 topics, Traditional Chinese).

The measurement clustered each conversation's comments with the Delphi
pipeline, built its topic hierarchy (ids, parents, keywords, the three comments
nearest each topic's centre; what is kept of it here is below) and sent it to Claude Haiku 5.5 and Claude
Sonnet 5.5 in one call per conversation, three times at each of two thinking
settings.

- `hierarchies/<conversation>.json`: the hierarchy the calls were built from,
  cut to the fields this crate reads and given the `schema` string. The sample
  comments for Bowling Green are as the measurement chose them from the export.
  Bowling Green keeps them because one test reads them: the request-body test
  rebuilds the call's body from this file and compares it, byte for byte, with
  the saved request. The vTaiwan and Mobilität files keep only what their
  tests read: the topic ids, layers, clusters, sizes and parents, and one
  invented Chinese or German sentence per topic as the sample, which gives the
  language check the comments' script and language. No source comment is left
  in them (some of the measurement's samples had been moderated out), and
  their keywords, which were words taken from the comments, are empty lists.
  The recorded replies are unchanged.
- `replies/<conversation>/<model>-<setting>-r<n>.json`: the reply body of each
  whole-hierarchy call, as the provider returned it (JSON re-serialized, content
  unchanged). `off` is the measurement's lowest thinking setting (Haiku
  `disabled`, Sonnet `between_tools`).
- `replies/bg2050/sonnet-off-urdu-own-call.json`: the reply to a different call
  of the same measurement, which asked Sonnet (thinking `between_tools`) for
  the Bowling Green names in Urdu; it came back mis-encoded (UTF-8 read as
  Windows-1251).
- `requests/bg2050-haiku-default.json` and `requests/bg2050-sonnet-off.json`:
  the request bodies of two of those calls, exactly as sent, byte for byte.
  They hold no key and no header.
