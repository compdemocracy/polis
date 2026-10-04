/**
 * The frozen Delphi storage codec, `delphi-storage-codec/1` (P-077 P2-0).
 *
 * Byte-for-byte mirror of `delphi/polismath/delphi_storage/codec.py`, which
 * holds the full rule text. One JSONL file per DynamoDB table ("family"): a
 * header line, then one canonical line per item, ordered by the canonical JSON
 * of the item's key values. Values keep the DynamoDB AttributeValue tags; `N`
 * stays DynamoDB's canonical decimal text and never passes through a JS
 * `Number`; sets are never lists; a JSON document stored as a string stays an
 * `S`. The golden files in `delphi/polismath/delphi_storage/golden/` are the
 * cross-language contract: Python writes them, this module must read and
 * rewrite them to the same bytes.
 *
 * Nothing in the running server imports this module yet; the characterization
 * fixtures and later phases do.
 */

export const CODEC_VERSION = "delphi-storage-codec/1";

type KeyType = "S" | "N" | "B";

/** Every DynamoDB table Delphi has (P-076 catalog T01-T20). */
export const FAMILIES: Record<
  string,
  { id: string; key: Array<[string, KeyType]> }
> = {
  Delphi_PCAConversationConfig: { id: "T01", key: [["zid", "S"]] },
  Delphi_PCAResults: {
    id: "T02",
    key: [
      ["zid", "S"],
      ["math_tick", "N"],
    ],
  },
  Delphi_KMeansClusters: {
    id: "T03",
    key: [
      ["zid_tick", "S"],
      ["group_id", "N"],
    ],
  },
  Delphi_CommentRouting: {
    id: "T04",
    key: [
      ["zid_tick", "S"],
      ["comment_id", "S"],
    ],
  },
  Delphi_RepresentativeComments: {
    id: "T05",
    key: [
      ["zid_tick_gid", "S"],
      ["comment_id", "S"],
    ],
  },
  Delphi_PCAParticipantProjections: {
    id: "T06",
    key: [
      ["zid_tick", "S"],
      ["participant_id", "S"],
    ],
  },
  Delphi_UMAPConversationConfig: {
    id: "T07",
    key: [["conversation_id", "S"]],
  },
  Delphi_CommentEmbeddings: {
    id: "T08",
    key: [
      ["conversation_id", "S"],
      ["comment_id", "N"],
    ],
  },
  Delphi_CommentHierarchicalClusterAssignments: {
    id: "T09",
    key: [
      ["conversation_id", "S"],
      ["comment_id", "N"],
    ],
  },
  Delphi_CommentClustersStructureKeywords: {
    id: "T10",
    key: [
      ["conversation_id", "S"],
      ["cluster_key", "S"],
    ],
  },
  Delphi_UMAPGraph: {
    id: "T11",
    key: [
      ["conversation_id", "S"],
      ["edge_id", "S"],
    ],
  },
  Delphi_CommentClustersFeatures: {
    id: "T12",
    key: [
      ["conversation_id", "S"],
      ["cluster_key", "S"],
    ],
  },
  Delphi_CommentClustersLLMTopicNames: {
    id: "T13",
    key: [
      ["conversation_id", "S"],
      ["topic_key", "S"],
    ],
  },
  Delphi_NarrativeReports: {
    id: "T14",
    key: [
      ["rid_section_model", "S"],
      ["timestamp", "S"],
    ],
  },
  Delphi_JobQueue: { id: "T15", key: [["job_id", "S"]] },
  Delphi_JobActiveGuard: { id: "T16", key: [["guard_key", "S"]] },
  Delphi_CommentExtremity: {
    id: "T17",
    key: [
      ["conversation_id", "S"],
      ["comment_id", "S"],
    ],
  },
  Delphi_TopicAgendaSelections: {
    id: "T18",
    key: [
      ["conversation_id", "S"],
      ["participant_id", "S"],
    ],
  },
  Delphi_CollectiveStatement: { id: "T19", key: [["zid_topic_jobid", "S"]] },
  report_narrative_store: {
    id: "T20",
    key: [
      ["rid_section_model", "S"],
      ["timestamp", "S"],
    ],
  },
};

/** Low-level AttributeValue, as `@aws-sdk/client-dynamodb` sends and returns it. */
export type AttributeValue =
  | { S: string }
  | { N: string }
  | { B: Uint8Array }
  | { BOOL: boolean }
  | { NULL: true }
  | { L: AttributeValue[] }
  | { M: Record<string, AttributeValue> }
  | { SS: string[] }
  | { NS: string[] }
  | { BS: Uint8Array[] };

export type Item = Record<string, AttributeValue>;

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

const NUMBER = /^([+-]?)(\d+\.?\d*|\.\d+)(?:[eE]([+-]?\d+))?$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** DynamoDB's canonical spelling of a number. */
export function canonicalNumber(text: unknown): string {
  if (typeof text !== "string") throw new CodecError("N must be text");
  const m = NUMBER.exec(text);
  if (!m) throw new CodecError(`invalid N ${JSON.stringify(text)}`);
  const sign = m[1];
  const body = m[2];
  const exp = parseInt(m[3] || "0", 10);
  const dot = body.indexOf(".");
  const whole = dot === -1 ? body : body.slice(0, dot);
  const frac = dot === -1 ? "" : body.slice(dot + 1);
  let digits = (whole + frac).replace(/^0+/, "");
  let point = exp - frac.length;
  if (!digits) return "0";
  const stripped = digits.replace(/0+$/, "");
  point += digits.length - stripped.length;
  digits = stripped;
  if (digits.length > 38)
    throw new CodecError(`N ${text} has more than 38 significant digits`);
  const lead = point + digits.length - 1;
  if (lead > 125 || lead < -130)
    throw new CodecError(`N ${text} outside DynamoDB's range`);
  let out: string;
  if (point >= 0) out = digits + "0".repeat(point);
  else if (-point >= digits.length)
    out = "0." + "0".repeat(-point - digits.length) + digits;
  else
    out =
      digits.slice(0, digits.length + point) +
      "." +
      digits.slice(digits.length + point);
  return sign === "-" ? "-" + out : out;
}

function utf8(s: string): Buffer {
  if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      s
    )
  )
    throw new CodecError("string holds a lone surrogate");
  return Buffer.from(s, "utf8");
}

const SHORT: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function str(s: string): string {
  utf8(s);
  let out = '"';
  for (const ch of s) {
    const short = SHORT[ch];
    if (short) out += short;
    else if (ch.charCodeAt(0) < 0x20)
      out += "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

function byUtf8(a: string, b: string): number {
  return Buffer.compare(utf8(a), utf8(b));
}

type Json = string | boolean | Json[] | { [k: string]: Json };

/** Canonical JSON for the codec's restricted value space. */
export function dumps(value: Json): string {
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return str(value);
  if (Array.isArray(value)) return "[" + value.map(dumps).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort(byUtf8)
        .map((k) => str(k) + ":" + dumps(value[k]))
        .join(",") +
      "}"
    );
  throw new CodecError("value outside the codec's JSON space");
}

/** Own enumerable property, safe for any attribute name (even "__proto__"). */
function put<T>(obj: Record<string, T>, k: string, v: T): void {
  Object.defineProperty(obj, k, {
    value: v,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function b64(raw: Uint8Array): string {
  return Buffer.from(raw).toString("base64");
}

function unb64(s: unknown): Uint8Array {
  if (typeof s !== "string" || !B64.test(s) || s.length % 4)
    throw new CodecError("B must be standard padded base64");
  const raw = Buffer.from(s, "base64");
  if (raw.toString("base64") !== s)
    throw new CodecError("B is not canonical base64");
  return new Uint8Array(raw);
}

function setSort<T>(tag: string, elems: T[], key: (e: T) => Buffer): T[] {
  if (!elems.length) throw new CodecError(`${tag} must not be empty`);
  const keyed = elems.map((e) => [key(e), e] as [Buffer, T]);
  keyed.sort((a, b) => Buffer.compare(a[0], b[0]));
  for (let i = 1; i < keyed.length; i++)
    if (Buffer.compare(keyed[i - 1][0], keyed[i][0]) === 0)
      throw new CodecError(`${tag} holds a duplicate element`);
  return keyed.map((p) => p[1]);
}

function one(av: unknown): [string, any] {
  if (!av || typeof av !== "object" || Array.isArray(av))
    throw new CodecError("AttributeValue must be an object");
  const keys = Object.keys(av);
  if (keys.length !== 1)
    throw new CodecError("AttributeValue must have exactly one tag");
  return [keys[0], (av as any)[keys[0]]];
}

function encodeAv(av: unknown): Json {
  const [tag, v] = one(av);
  switch (tag) {
    case "S":
      if (typeof v !== "string") throw new CodecError("S must be text");
      utf8(v);
      return { S: v };
    case "N":
      return { N: canonicalNumber(v) };
    case "B":
      if (!(v instanceof Uint8Array)) throw new CodecError("B must be bytes");
      return { B: b64(v) };
    case "BOOL":
      if (typeof v !== "boolean")
        throw new CodecError("BOOL must be a boolean");
      return { BOOL: v };
    case "NULL":
      if (v !== true) throw new CodecError("NULL must be true");
      return { NULL: true };
    case "L":
      if (!Array.isArray(v)) throw new CodecError("L must be a list");
      return { L: v.map(encodeAv) };
    case "M": {
      if (!v || typeof v !== "object" || Array.isArray(v))
        throw new CodecError("M must be a map");
      const m: Record<string, Json> = {};
      for (const k of Object.keys(v)) put(m, k, encodeAv(v[k]));
      return { M: m };
    }
    case "SS":
      if (!Array.isArray(v) || !v.every((e) => typeof e === "string"))
        throw new CodecError("SS elements must be text");
      return { SS: setSort("SS", [...v], utf8) };
    case "NS":
      if (!Array.isArray(v)) throw new CodecError("NS must be a list");
      return { NS: setSort("NS", v.map(canonicalNumber), utf8) };
    case "BS":
      if (!Array.isArray(v) || !v.every((e) => e instanceof Uint8Array))
        throw new CodecError("BS elements must be bytes");
      return {
        BS: setSort("BS", [...v] as Uint8Array[], (e) => Buffer.from(e)).map(
          b64
        ),
      };
    default:
      throw new CodecError(`unknown AttributeValue tag ${tag}`);
  }
}

function decodeAv(tv: unknown): AttributeValue {
  const [tag, v] = one(tv);
  switch (tag) {
    case "S":
    case "N":
      if (typeof v !== "string") throw new CodecError(`${tag} must be text`);
      return { [tag]: v } as AttributeValue;
    case "B":
      return { B: unb64(v) };
    case "BOOL":
      if (typeof v !== "boolean")
        throw new CodecError("BOOL must be a boolean");
      return { BOOL: v };
    case "NULL":
      if (v !== true) throw new CodecError("NULL must be true");
      return { NULL: true };
    case "L":
      if (!Array.isArray(v)) throw new CodecError("L must be a list");
      return { L: v.map(decodeAv) };
    case "M": {
      if (!v || typeof v !== "object" || Array.isArray(v))
        throw new CodecError("M must be a map");
      const m: Record<string, AttributeValue> = {};
      for (const k of Object.keys(v)) put(m, k, decodeAv(v[k]));
      return { M: m };
    }
    case "SS":
    case "NS":
      if (!Array.isArray(v) || !v.every((e) => typeof e === "string"))
        throw new CodecError(`${tag} must be a list of text`);
      return { [tag]: [...v] } as AttributeValue;
    case "BS":
      if (!Array.isArray(v)) throw new CodecError("BS must be a list");
      return { BS: v.map(unb64) };
    default:
      throw new CodecError(`unknown tag ${tag}`);
  }
}

function family(name: string) {
  const f = Object.prototype.hasOwnProperty.call(FAMILIES, name)
    ? FAMILIES[name]
    : undefined;
  if (!f) throw new CodecError(`unknown family ${name}`);
  return f;
}

function keyJson(name: string, tagged: Record<string, any>): string {
  const parts: Json[] = [];
  for (const [attr, ktype] of family(name).key) {
    const tv = Object.prototype.hasOwnProperty.call(tagged, attr)
      ? tagged[attr]
      : undefined;
    if (!tv) throw new CodecError(`${name}: item lacks key attribute ${attr}`);
    const tags = Object.keys(tv);
    if (tags.length !== 1 || tags[0] !== ktype)
      throw new CodecError(`${name}: key ${attr} must be ${ktype}`);
    parts.push(tv);
  }
  return dumps(parts);
}

/** One item -> its canonical line (no newline). */
export function encodeItem(name: string, item: Item): string {
  if (!item || typeof item !== "object" || !Object.keys(item).length)
    throw new CodecError("item must be a non-empty map");
  const tagged: Record<string, Json> = {};
  for (const k of Object.keys(item)) {
    if (!k) throw new CodecError("attribute names must be non-empty text");
    put(tagged, k, encodeAv(item[k]));
  }
  keyJson(name, tagged);
  return dumps(tagged);
}

export function header(name: string): string {
  return dumps({
    codec: CODEC_VERSION,
    family: name,
    key: family(name).key.map(([a]) => a),
  });
}

/** Items of one family -> the complete file bytes. */
export function encodeFamily(name: string, items: Item[]): Buffer {
  const lines = items.map((item) => {
    const line = encodeItem(name, item);
    return [utf8(keyJson(name, JSON.parse(line))), line] as [Buffer, string];
  });
  lines.sort((a, b) => Buffer.compare(a[0], b[0]));
  for (let i = 1; i < lines.length; i++)
    if (Buffer.compare(lines[i - 1][0], lines[i][0]) === 0)
      throw new CodecError(`${name}: duplicate key ${lines[i][0].toString()}`);
  return Buffer.from(
    [header(name), ...lines.map((l) => l[1])].join("\n") + "\n",
    "utf8"
  );
}

/** File bytes -> family and items. Refuses anything not byte-canonical. */
export function decodeFamily(data: Uint8Array): {
  family: string;
  items: Item[];
} {
  const buf = Buffer.from(data);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  if (!text.endsWith("\n"))
    throw new CodecError("file must end with a newline");
  const lines = text.slice(0, -1).split("\n");
  const head = JSON.parse(lines[0]);
  const name = head && typeof head === "object" ? head.family : undefined;
  if (
    !head ||
    head.codec !== CODEC_VERSION ||
    typeof name !== "string" ||
    !Object.prototype.hasOwnProperty.call(FAMILIES, name)
  )
    throw new CodecError(`bad header ${lines[0]}`);
  if (lines[0] !== header(name))
    throw new CodecError("header is not canonical");
  const items = lines.slice(1).map((line, i) => {
    const tagged = JSON.parse(line);
    if (!tagged || typeof tagged !== "object" || Array.isArray(tagged))
      throw new CodecError(`line ${i + 2}: item must be an object`);
    const item: Item = {};
    for (const k of Object.keys(tagged)) put(item, k, decodeAv(tagged[k]));
    if (encodeItem(name, item) !== line)
      throw new CodecError(`line ${i + 2}: not canonical`);
    return item;
  });
  if (Buffer.compare(encodeFamily(name, items), buf) !== 0)
    throw new CodecError("items are not in canonical order or repeat a key");
  return { family: name, items };
}
