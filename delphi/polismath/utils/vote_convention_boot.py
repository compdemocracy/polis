"""The database's declaration of the stored vote sign, read at startup (P-078).

Migration 000025 gives the database one row, ``public.vote_convention``, that
names which stored value means "agree". Every Python process that reads votes
(the math poller, the math pipeline stage, the Delphi job child and its
poller) calls :func:`require_declared_convention` before its first vote read
and refuses to run against:

- no table or function: migration 000025 is not applied;
- a table with no row: the database holds votes and nobody has declared its
  sign (the message names the one command that declares it);
- a contract this build does not know: a newer release changed the database;
- a sign other than the one this build is built for: serving it would read
  and write every vote inverted.

The sign this build is built for is the chokepoint's
:data:`~polismath.utils.vote_convention.STORAGE_AGREE_VALUE`; no literal sign
appears here. The messages are mirrored by the server
(``server/src/votes/dbConvention.ts``) and the coordinator
(``coordinator-rs/src/vote_convention.rs``). Standard library plus the
chokepoint only, so any entry point can import it first.
"""
from __future__ import annotations

import logging
import sys
from dataclasses import dataclass
from typing import Any, Callable, Mapping, NoReturn, Optional, Sequence

from polismath.utils.vote_convention import (
    STORAGE_AGREE_VALUE,
    StorageConvention,
    validate_storage_agree_value,
)

#: The installed-surface contracts this build understands.
SUPPORTED_VOTE_CONTRACTS: tuple = (1,)
VOTE_CONVENTION_GUIDE = "docs/vote-convention-upgrade.md"
VOTE_CONVENTION_MIGRATION = "server/postgres/migrations/000025_vote_convention.sql"

PRESENT_SQL = (
    "SELECT to_regclass('public.vote_convention') IS NOT NULL"
    " AND to_regprocedure('public.vote_convention_current()') IS NOT NULL AS present")
ROW_SQL = "SELECT version, agree_value, contract_version FROM public.vote_convention_current()"

#: ``query(sql) -> rows`` as dict-like mappings (every client here has one).
Query = Callable[[str], Sequence[Mapping[str, Any]]]

NO_TABLE = "no-table"
NO_ROW = "no-row"
DECLARED = "declared"


@dataclass(frozen=True)
class DatabaseConvention:
    """What the database declares, before it is judged."""

    state: str
    version: Optional[int] = None
    agree_value: Optional[int] = None
    contract_version: Optional[int] = None


class VoteConventionRefusal(Exception):
    """This build may not run against this database. ``code`` is closed:
    ``vote_convention_not_installed``, ``vote_convention_undeclared``,
    ``vote_convention_contract_unsupported``, ``vote_convention_mismatch``."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def signed(value: int) -> str:
    return f"{int(value):+d}"


def declare_command(agree: int = STORAGE_AGREE_VALUE) -> str:
    """The exact command an operator runs to declare an existing database's sign."""
    return f"make vote-convention-declare AGREE={signed(agree)}"


def _integer(value: Any, what: str) -> int:
    if isinstance(value, bool) or value is None:
        raise VoteConventionRefusal(
            "vote_convention_mismatch",
            f"Polis cannot start: public.vote_convention_current() returned a {what} that is not an "
            f"integer ({value!r}). Nothing has been changed. Guide: {VOTE_CONVENTION_GUIDE}#inconsistent")
    try:
        return int(value)
    except (TypeError, ValueError):
        raise VoteConventionRefusal(
            "vote_convention_mismatch",
            f"Polis cannot start: public.vote_convention_current() returned a {what} that is not an "
            f"integer ({value!r}). Nothing has been changed. Guide: {VOTE_CONVENTION_GUIDE}#inconsistent")


def read_database_convention(query: Query) -> DatabaseConvention:
    """What the database declares, without judging it."""
    present = list(query(PRESENT_SQL))
    if not present or present[0]["present"] is not True:
        return DatabaseConvention(NO_TABLE)
    rows = list(query(ROW_SQL))
    if not rows:
        return DatabaseConvention(NO_ROW)
    if len(rows) != 1:
        raise VoteConventionRefusal(
            "vote_convention_mismatch",
            f"Polis cannot start: public.vote_convention_current() returned {len(rows)} rows; exactly one "
            f"is required. Nothing has been changed. Guide: {VOTE_CONVENTION_GUIDE}#inconsistent")
    row = rows[0]
    return DatabaseConvention(
        DECLARED,
        version=_integer(row["version"], "version"),
        agree_value=_integer(row["agree_value"], "agree_value"),
        contract_version=_integer(row["contract_version"], "contract_version"))


def judge_database_convention(
    found: DatabaseConvention, component: str,
    built_for: int = STORAGE_AGREE_VALUE,
    supported_contracts: Sequence[int] = SUPPORTED_VOTE_CONTRACTS,
) -> Optional[VoteConventionRefusal]:
    """The decision: may a build made for ``built_for`` run against what the
    database declares? ``None`` means yes; otherwise the refusal to raise."""
    built_for = validate_storage_agree_value(built_for, field="built_for")
    prefix = f"Polis cannot start ({component}):"
    if found.state == NO_TABLE:
        return VoteConventionRefusal(
            "vote_convention_not_installed",
            f"{prefix} this database has no vote_convention table, so it does not record which stored vote "
            f"value means \"agree\". Migration 000025 has not been applied. Nothing has been changed. "
            f"Next: back up the database, apply {VOTE_CONVENTION_MIGRATION} (see docs/migrations.md), "
            f"then, if the database already holds votes, run \"{declare_command(built_for)}\". "
            f"Guide: {VOTE_CONVENTION_GUIDE}#guard")
    if found.state == NO_ROW:
        return VoteConventionRefusal(
            "vote_convention_undeclared",
            f"{prefix} this database does not record which stored vote value means \"agree\". "
            f"Older Polis databases store agree as {signed(built_for)}; this release no longer assumes it. "
            f"Nothing has been changed. Next: back up the database, then declare its convention with "
            f"\"{declare_command(built_for)}\" (AGREE={signed(-built_for)} only if your deployment reversed "
            f"its vote signs itself). Guide: {VOTE_CONVENTION_GUIDE}#declare")
    if found.state != DECLARED:
        raise ValueError(f"unknown database convention state {found.state!r}")
    if found.contract_version not in supported_contracts:
        return VoteConventionRefusal(
            "vote_convention_contract_unsupported",
            f"{prefix} this database uses vote convention contract {found.contract_version}; this release "
            f"understands {', '.join(str(c) for c in supported_contracts)}. A newer Polis release changed the "
            f"database. Nothing has been changed. Next: run that newer release, or restore the backup taken "
            f"before it. Guide: {VOTE_CONVENTION_GUIDE}#a-newer-database")
    if found.agree_value != built_for:
        return VoteConventionRefusal(
            "vote_convention_mismatch",
            f"{prefix} this database declares vote convention version {found.version} "
            f"(agree = {signed(found.agree_value)}), but this release of the {component} is built for "
            f"agree = {signed(built_for)}. Running it would read and write every vote inverted. "
            f"Nothing has been changed. Next: run a Polis release built for the declared convention, or "
            f"restore the database this release was built for. Guide: {VOTE_CONVENTION_GUIDE}#mismatch")
    return None


def require_declared_convention(
    query: Query, component: str, built_for: int = STORAGE_AGREE_VALUE,
) -> StorageConvention:
    """Read, judge, and return the declared convention, or raise
    :class:`VoteConventionRefusal` with the operator message."""
    found = read_database_convention(query)
    refusal = judge_database_convention(found, component, built_for)
    if refusal is not None:
        raise refusal
    return StorageConvention(found.agree_value, found.version, "database")


def refuse_and_exit(refusal: VoteConventionRefusal, log: Optional[logging.Logger] = None,
                    exit_code: int = 1) -> NoReturn:
    """Print the operator message, log it, and exit: the one way every Python
    entry point ends a refused start."""
    print(refusal.message, file=sys.stderr, flush=True)
    (log or logging.getLogger(__name__)).error(refusal.message)
    raise SystemExit(exit_code)
