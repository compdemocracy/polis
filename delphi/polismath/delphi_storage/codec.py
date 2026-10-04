"""The frozen Delphi storage codec: DynamoDB items <-> JSONL per family.

Version ``delphi-storage-codec/1``. This module is the single serialisation of
Delphi result rows used by every later phase of the DynamoDB-to-Postgres move:
the pipeline's family files (P-077 P2-2), the legacy import (P2-4) and the
reverse copy all write and read these exact bytes. It is stdlib-only and is
mirrored byte for byte by ``server/src/utils/delphiStorageCodec.ts``; the golden
files under ``golden/`` are the cross-language contract. Changing any rule below
is a new codec version, never an edit of this one.

File format (one file per family, UTF-8, ``\\n`` line ends, trailing ``\\n``):

* line 1, the header: ``{"codec":"delphi-storage-codec/1","family":"<table>","key":[<key attribute names>]}``
* one line per item: a canonical JSON object mapping every attribute name to a
  tagged DynamoDB AttributeValue (``S``, ``N``, ``B``, ``BOOL``, ``NULL``,
  ``L``, ``M``, ``SS``, ``NS``, ``BS``), exactly the DynamoDB wire form with the
  rules below. Items are ordered by the UTF-8 bytes of the canonical JSON of
  their key values (in key order); a duplicate key is refused.

Canonical JSON: no whitespace; object keys sorted by UTF-8 bytes; strings
emitted raw except ``"``, ``\\``, ``\\b \\f \\n \\r \\t`` and other characters
below U+0020 as lowercase ``\\u00xx``. A lone surrogate is refused. The only
JSON scalars that occur are strings, ``true`` and ``false``.

Value rules (P-076 section 6, "conversion rules"):

* ``N`` holds DynamoDB's own canonical text: plain decimal notation, no
  exponent, no leading zeros, no trailing fractional zeros, ``-0`` is ``0``;
  at most 38 significant digits, magnitude within 1E-130 .. <1E+126. Numbers
  never pass through a binary float. Encoding canonicalises; decoding refuses
  non-canonical text, so a file has exactly one spelling.
* ``S`` may be empty and may contain U+0000 (the codec preserves it; the
  Postgres importer quarantines it, JSONB cannot hold it).
* ``B`` is standard base64 with padding.
* Sets are never lists: ``SS``/``NS``/``BS`` are non-empty, duplicate-free, and
  ordered by the UTF-8 bytes of the element text (for ``BS``, the raw bytes).
  DynamoDB does not preserve set order, so the codec fixes one.
* A JSON document stored as a string stays an ``S``; a map stays an ``M``.
* ``L`` keeps its order; ``M`` keys are sorted like any object.

Decoding returns low-level AttributeValue dicts (boto3 client form, ``B`` as
``bytes``). ``from_python``/``to_python`` convert to and from the
boto3-resource value form (``Decimal``, ``set``, ``bytes``...); ``float`` is
refused, as boto3 refuses it.
"""

from __future__ import annotations

import base64
import json
import re
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Sequence, Tuple

CODEC_VERSION = "delphi-storage-codec/1"

# Every DynamoDB table Delphi has (P-076 catalog T01-T20): name -> key.
# Key entries are (attribute name, key type S|N|B), hash key first.
FAMILIES: Dict[str, Dict[str, Any]] = {
    "Delphi_PCAConversationConfig": {"id": "T01", "key": [("zid", "S")]},
    "Delphi_PCAResults": {"id": "T02", "key": [("zid", "S"), ("math_tick", "N")]},
    "Delphi_KMeansClusters": {"id": "T03", "key": [("zid_tick", "S"), ("group_id", "N")]},
    "Delphi_CommentRouting": {"id": "T04", "key": [("zid_tick", "S"), ("comment_id", "S")]},
    "Delphi_RepresentativeComments": {"id": "T05", "key": [("zid_tick_gid", "S"), ("comment_id", "S")]},
    "Delphi_PCAParticipantProjections": {"id": "T06", "key": [("zid_tick", "S"), ("participant_id", "S")]},
    "Delphi_UMAPConversationConfig": {"id": "T07", "key": [("conversation_id", "S")]},
    "Delphi_CommentEmbeddings": {"id": "T08", "key": [("conversation_id", "S"), ("comment_id", "N")]},
    "Delphi_CommentHierarchicalClusterAssignments": {"id": "T09", "key": [("conversation_id", "S"), ("comment_id", "N")]},
    "Delphi_CommentClustersStructureKeywords": {"id": "T10", "key": [("conversation_id", "S"), ("cluster_key", "S")]},
    "Delphi_UMAPGraph": {"id": "T11", "key": [("conversation_id", "S"), ("edge_id", "S")]},
    "Delphi_CommentClustersFeatures": {"id": "T12", "key": [("conversation_id", "S"), ("cluster_key", "S")]},
    "Delphi_CommentClustersLLMTopicNames": {"id": "T13", "key": [("conversation_id", "S"), ("topic_key", "S")]},
    "Delphi_NarrativeReports": {"id": "T14", "key": [("rid_section_model", "S"), ("timestamp", "S")]},
    "Delphi_JobQueue": {"id": "T15", "key": [("job_id", "S")]},
    "Delphi_JobActiveGuard": {"id": "T16", "key": [("guard_key", "S")]},
    "Delphi_CommentExtremity": {"id": "T17", "key": [("conversation_id", "S"), ("comment_id", "S")]},
    "Delphi_TopicAgendaSelections": {"id": "T18", "key": [("conversation_id", "S"), ("participant_id", "S")]},
    "Delphi_CollectiveStatement": {"id": "T19", "key": [("zid_topic_jobid", "S")]},
    "report_narrative_store": {"id": "T20", "key": [("rid_section_model", "S"), ("timestamp", "S")]},
}

_TAGS = ("S", "N", "B", "BOOL", "NULL", "L", "M", "SS", "NS", "BS")
_NUMBER = re.compile(r"^([+-]?)([0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE]([+-]?[0-9]+))?$")
_B64 = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")


class CodecError(ValueError):
    """A value, line or file outside codec version 1."""


# ---------------------------------------------------------------- numbers


def canonical_number(text: str) -> str:
    """DynamoDB's canonical spelling of a number, or CodecError."""
    if not isinstance(text, str):
        raise CodecError(f"N must be text, got {type(text).__name__}")
    m = _NUMBER.match(text)
    if not m:
        raise CodecError(f"invalid N {text!r}")
    sign, body, exp = m.group(1), m.group(2), int(m.group(3) or "0")
    if "." in body:
        whole, frac = body.split(".", 1)
    else:
        whole, frac = body, ""
    digits = (whole + frac).lstrip("0")
    # value = int(whole+frac) * 10**(exp - len(frac))
    point = exp - len(frac)
    if not digits:
        return "0"
    stripped = digits.rstrip("0")
    point += len(digits) - len(stripped)
    digits = stripped
    if len(digits) > 38:
        raise CodecError(f"N {text!r} has more than 38 significant digits")
    # magnitude: the leading digit sits at 10**(point + len(digits) - 1)
    lead = point + len(digits) - 1
    if lead > 125 or lead < -130:
        raise CodecError(f"N {text!r} outside DynamoDB's range")
    if point >= 0:
        out = digits + "0" * point
    elif -point >= len(digits):
        out = "0." + "0" * (-point - len(digits)) + digits
    else:
        out = digits[:point] + "." + digits[point:]
    return ("-" + out) if sign == "-" else out


# ------------------------------------------------------------ canonical JSON


def _utf8(s: str) -> bytes:
    try:
        return s.encode("utf-8")
    except UnicodeEncodeError as e:  # lone surrogate
        raise CodecError("string holds a lone surrogate") from e


_SHORT = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _str(s: str) -> str:
    _utf8(s)
    out = ['"']
    for ch in s:
        if ch in _SHORT:
            out.append(_SHORT[ch])
        elif ord(ch) < 0x20:
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _sorted_keys(obj: Dict[str, Any]) -> List[str]:
    return sorted(obj.keys(), key=_utf8)


def dumps(value: Any) -> str:
    """Canonical JSON for the restricted value space (dict/list/str/bool)."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _str(value)
    if isinstance(value, list):
        return "[" + ",".join(dumps(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(_str(k) + ":" + dumps(value[k]) for k in _sorted_keys(value)) + "}"
    raise CodecError(f"value outside the codec's JSON space: {type(value).__name__}")


# ------------------------------------------------------- attribute values


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _set_sort(tag: str, elems: Sequence[Any]) -> List[Any]:
    if not elems:
        raise CodecError(f"{tag} must not be empty")
    if tag == "BS":
        keyed = sorted(((bytes(e), e) for e in elems), key=lambda p: p[0])
    else:
        keyed = sorted(((_utf8(e), e) for e in elems), key=lambda p: p[0])
    for (a, _), (b, _) in zip(keyed, keyed[1:]):
        if a == b:
            raise CodecError(f"{tag} holds a duplicate element")
    return [e for _, e in keyed]


def _encode_av(av: Any) -> Dict[str, Any]:
    """AttributeValue (boto3 client form) -> tagged JSON value."""
    if not isinstance(av, dict) or len(av) != 1:
        raise CodecError(f"AttributeValue must have exactly one tag: {av!r}")
    (tag, v), = av.items()
    if tag == "S":
        if not isinstance(v, str):
            raise CodecError("S must be text")
        _utf8(v)
        return {"S": v}
    if tag == "N":
        return {"N": canonical_number(v)}
    if tag == "B":
        if not isinstance(v, (bytes, bytearray)):
            raise CodecError("B must be bytes")
        return {"B": _b64(bytes(v))}
    if tag == "BOOL":
        if not isinstance(v, bool):
            raise CodecError("BOOL must be a boolean")
        return {"BOOL": True} if v else {"BOOL": False}
    if tag == "NULL":
        if v is not True:
            raise CodecError("NULL must be true")
        return {"NULL": True}
    if tag == "L":
        if not isinstance(v, (list, tuple)):
            raise CodecError("L must be a list")
        return {"L": [_encode_av(x) for x in v]}
    if tag == "M":
        if not isinstance(v, dict):
            raise CodecError("M must be a map")
        for k in v:
            if not isinstance(k, str):
                raise CodecError("M keys must be text")
        return {"M": {k: _encode_av(x) for k, x in v.items()}}
    if tag in ("SS", "NS", "BS") and not isinstance(v, (list, tuple)):
        raise CodecError(f"{tag} must be a list")
    if tag == "SS":
        if not all(isinstance(e, str) for e in v):
            raise CodecError("SS elements must be text")
        return {"SS": _set_sort("SS", list(v))}
    if tag == "NS":
        return {"NS": _set_sort("NS", [canonical_number(e) for e in v])}
    if tag == "BS":
        if not all(isinstance(e, (bytes, bytearray)) for e in v):
            raise CodecError("BS elements must be bytes")
        return {"BS": [_b64(e) for e in _set_sort("BS", [bytes(e) for e in v])]}
    raise CodecError(f"unknown AttributeValue tag {tag!r}")


def _decode_av(tv: Any) -> Dict[str, Any]:
    """Tagged JSON value (already validated canonical) -> AttributeValue."""
    if not isinstance(tv, dict) or len(tv) != 1:
        raise CodecError(f"tagged value must have exactly one tag: {tv!r}")
    (tag, v), = tv.items()
    if tag == "S":
        if not isinstance(v, str):
            raise CodecError("S must be text")
        return {"S": v}
    if tag == "N":
        if not isinstance(v, str):
            raise CodecError("N must be text")
        return {"N": v}
    if tag == "B":
        return {"B": _unb64(v)}
    if tag == "BOOL":
        if not isinstance(v, bool):
            raise CodecError("BOOL must be a boolean")
        return {"BOOL": v}
    if tag == "NULL":
        if v is not True:
            raise CodecError("NULL must be true")
        return {"NULL": True}
    if tag == "L":
        if not isinstance(v, list):
            raise CodecError("L must be a list")
        return {"L": [_decode_av(x) for x in v]}
    if tag == "M":
        if not isinstance(v, dict):
            raise CodecError("M must be a map")
        return {"M": {k: _decode_av(x) for k, x in v.items()}}
    if tag in ("SS", "NS"):
        if not isinstance(v, list) or not all(isinstance(e, str) for e in v):
            raise CodecError(f"{tag} must be a list of text")
        return {tag: list(v)}
    if tag == "BS":
        if not isinstance(v, list):
            raise CodecError("BS must be a list")
        return {"BS": [_unb64(e) for e in v]}
    raise CodecError(f"unknown tag {tag!r}")


def _unb64(s: Any) -> bytes:
    if not isinstance(s, str) or not _B64.match(s) or len(s) % 4:
        raise CodecError("B must be standard padded base64")
    raw = base64.b64decode(s, validate=True)
    if _b64(raw) != s:
        raise CodecError("B is not canonical base64")
    return raw


# --------------------------------------------------------------- items/lines


def _family(name: str) -> Dict[str, Any]:
    if name not in FAMILIES:
        raise CodecError(f"unknown family {name!r}")
    return FAMILIES[name]


def _key_json(family: str, tagged_item: Dict[str, Any]) -> str:
    parts = []
    for attr, ktype in _family(family)["key"]:
        if attr not in tagged_item:
            raise CodecError(f"{family}: item lacks key attribute {attr!r}")
        tv = tagged_item[attr]
        if list(tv.keys()) != [ktype]:
            raise CodecError(f"{family}: key {attr!r} must be {ktype}")
        parts.append(tv)
    return dumps(parts)


def encode_item(family: str, item: Dict[str, Any]) -> str:
    """One AttributeValue item -> its canonical line (no newline)."""
    if not isinstance(item, dict) or not item:
        raise CodecError("item must be a non-empty map")
    tagged = {}
    for k, v in item.items():
        if not isinstance(k, str) or not k:
            raise CodecError("attribute names must be non-empty text")
        tagged[k] = _encode_av(v)
    _key_json(family, tagged)
    return dumps(tagged)


def header(family: str) -> str:
    return dumps({"codec": CODEC_VERSION, "family": family, "key": [a for a, _ in _family(family)["key"]]})


def encode_family(family: str, items: Iterable[Dict[str, Any]]) -> bytes:
    """Items of one family -> the complete file bytes."""
    lines = []
    for item in items:
        line = encode_item(family, item)
        tagged = json.loads(line)
        lines.append((_utf8(_key_json(family, tagged)), line))
    lines.sort(key=lambda p: p[0])
    for (a, _), (b, _) in zip(lines, lines[1:]):
        if a == b:
            raise CodecError(f"{family}: duplicate key {a.decode('utf-8')}")
    return ("\n".join([header(family)] + [l for _, l in lines]) + "\n").encode("utf-8")


def decode_family(data: bytes) -> Tuple[str, List[Dict[str, Any]]]:
    """File bytes -> (family, items). Refuses anything not byte-canonical."""
    if not isinstance(data, (bytes, bytearray)):
        raise CodecError("decode_family takes bytes")
    try:
        text = bytes(data).decode("utf-8")
    except UnicodeDecodeError as e:
        raise CodecError("file is not UTF-8") from e
    if not text.endswith("\n"):
        raise CodecError("file must end with a newline")
    lines = text[:-1].split("\n")
    head = json.loads(lines[0])
    family = head.get("family") if isinstance(head, dict) else None
    if not isinstance(head, dict) or head.get("codec") != CODEC_VERSION or family not in FAMILIES:
        raise CodecError(f"bad header {lines[0]!r}")
    if lines[0] != header(family):
        raise CodecError("header is not canonical")
    items = []
    for n, line in enumerate(lines[1:], start=2):
        tagged = json.loads(line)
        if not isinstance(tagged, dict):
            raise CodecError(f"line {n}: item must be an object")
        item = {k: _decode_av(v) for k, v in tagged.items()}
        if encode_item(family, item) != line:
            raise CodecError(f"line {n}: not canonical")
        items.append(item)
    if encode_family(family, items) != bytes(data):
        raise CodecError("items are not in canonical order or repeat a key")
    return family, items


# ------------------------------------------------- boto3-resource value form


def from_python(value: Any) -> Dict[str, Any]:
    """boto3-resource value (TypeSerializer semantics) -> AttributeValue."""
    if value is None:
        return {"NULL": True}
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, float):
        raise CodecError("float is refused; use Decimal")
    if isinstance(value, (int, Decimal)):
        if isinstance(value, Decimal) and not value.is_finite():
            raise CodecError("non-finite Decimal")
        return {"N": canonical_number(str(value))}
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, (bytes, bytearray)):
        return {"B": bytes(value)}
    if isinstance(value, (set, frozenset)):
        elems = list(value)
        if elems and all(isinstance(e, str) for e in elems):
            return {"SS": elems}
        if elems and all(isinstance(e, (bytes, bytearray)) for e in elems):
            return {"BS": [bytes(e) for e in elems]}
        if elems and all(isinstance(e, (int, Decimal)) and not isinstance(e, bool) for e in elems):
            return {"NS": [str(e) for e in elems]}
        raise CodecError("set must be non-empty and of one of text, number or bytes")
    if isinstance(value, (list, tuple)):
        return {"L": [from_python(v) for v in value]}
    if isinstance(value, dict):
        return {"M": {k: from_python(v) for k, v in value.items()}}
    raise CodecError(f"no DynamoDB type for {type(value).__name__}")


def to_python(av: Dict[str, Any]) -> Any:
    """AttributeValue -> boto3-resource value (TypeDeserializer semantics)."""
    (tag, v), = av.items()
    if tag == "S":
        return v
    if tag == "N":
        return Decimal(v)
    if tag == "B":
        return bytes(v)
    if tag == "BOOL":
        return v
    if tag == "NULL":
        return None
    if tag == "L":
        return [to_python(x) for x in v]
    if tag == "M":
        return {k: to_python(x) for k, x in v.items()}
    if tag == "SS":
        return set(v)
    if tag == "NS":
        return {Decimal(x) for x in v}
    if tag == "BS":
        return {bytes(x) for x in v}
    raise CodecError(f"unknown tag {tag!r}")


def item_from_python(values: Dict[str, Any]) -> Dict[str, Any]:
    return {k: from_python(v) for k, v in values.items()}
