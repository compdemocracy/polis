"""Immutable run-bound PostgreSQL results using the frozen storage codec.

The caller owns the connection and transaction. Methods never commit, allowing
an importer to stage, seal and finalize atomically. Normal graph children emit
``family_files`` with :func:`family_files`; the fenced artifact insert stores
those bytes in the same transaction as successful queue finalization.
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping

from .codec import (
    CODEC_VERSION, FAMILIES, CodecError, decode_family, encode_family,
    header, item_from_python, to_python,
)
import json

RESULT_FAMILIES = frozenset(FAMILIES) - {"Delphi_JobQueue", "Delphi_JobActiveGuard"}


def family_files(families: Mapping[str, Iterable[dict[str, Any]]]) -> dict[str, str]:
    """Encode native Python rows; floats must first follow the existing Decimal writer conversion."""
    result = {}
    for family, items in families.items():
        if family not in RESULT_FAMILIES:
            raise CodecError(f"not a result family: {family}")
        result[family] = encode_family(family, (item_from_python(x) for x in items)).decode("utf-8")
    return result


def decode_rows(family: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate tagged JSONB values with codec/1 before returning Python types."""
    from .codec import dumps
    _, decoded = decode_family((header(family) + "\n" + "".join(dumps(row) + "\n" for row in rows)).encode("utf-8"))
    return [{name: to_python(value) for name, value in row.items()} for row in decoded]


class PostgresResultReader:
    def __init__(self, connection: Any, env: str):
        self.connection, self.env = connection, env

    def _call(self, name: str, casts: str, args: tuple[Any, ...]) -> Any:
        # Names and casts are internal constants; all external values bind.
        with self.connection.cursor() as cursor:
            cursor.execute(f"SELECT public.{name}({casts})", (self.env, *args))
            value = cursor.fetchone()[0]
            return json.loads(value) if isinstance(value, str) else value

    def read_artifact_family(self, artifact_id: str, family: str) -> list[dict[str, Any]]:
        rows = self._call("pd_result_artifact_family", "%s::text,%s::uuid,%s::text", (artifact_id, family))
        return decode_rows(family, rows)

    def read_served_family(self, zid: int, scope: str, family: str) -> list[dict[str, Any]] | None:
        rows = self._call("pd_result_served", "%s::text,%s::integer,%s::text,%s::text", (zid, scope, family))
        return None if rows is None else decode_rows(family, rows)

    def read_served_bundle(self, zid: int, scope: str) -> dict[str, Any] | None:
        reply = self._call("pd_result_served_bundle", "%s::text,%s::integer,%s::text", (zid, scope))
        if reply is None:
            return None
        return {"generation": reply["generation"], "families": {
            family: decode_rows(family, rows) for family, rows in reply["families"].items()
        }}


class PostgresResultStore(PostgresResultReader):
    def __init__(self, connection: Any, env: str, job_id: str, owner_id: str,
                 attempt_id: str, lease_epoch: int):
        super().__init__(connection, env)
        self.token = (job_id, owner_id, attempt_id, lease_epoch)

    def write_family(self, family: str, items: Iterable[dict[str, Any]]) -> dict[str, Any]:
        wire = family_files({family: items})[family]
        return self.write_family_wire(family, wire)

    def write_family_wire(self, family: str, wire: str) -> dict[str, Any]:
        actual_family, _ = decode_family(wire.encode("utf-8"))
        if family != actual_family or family not in RESULT_FAMILIES:
            raise CodecError("result family mismatch")
        return self._call("pd_result_put_family", "%s::text,%s::uuid,%s::uuid,%s::uuid,%s::bigint,%s::text,%s::text", (*self.token, family, wire))

    def finish(self) -> dict[str, Any]:
        return self._call("pd_result_seal", "%s::text,%s::uuid,%s::uuid,%s::uuid,%s::bigint", self.token)
