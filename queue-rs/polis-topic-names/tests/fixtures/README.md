# Fixtures

Every file here comes from one measurement of topic naming made on 2026-11-22
over three public conversations, each from its public openData export:

- `bg2050`: Bowling Green 2050 (185 topics, English);
- `mobilitaet`: an Austrian conversation on mobility (103 topics, German);
- `vtaiwan`: vTaiwan's conversation on UberX (16 topics, Traditional Chinese).

The measurement clustered each conversation's comments with the Delphi
pipeline, built its topic hierarchy (ids, parents, keywords, the three comments
nearest each topic's centre) and sent it to Claude Haiku 5.5 and Claude
Sonnet 5.5 in one call per conversation, three times at each of two thinking
settings.

- `hierarchies/<conversation>.json`: the hierarchy the calls were built from,
  cut to the fields this crate reads and given the `schema` string. The sample
  comments are as the measurement chose them from the export.
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
