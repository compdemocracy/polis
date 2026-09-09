"""Typed shapes for the dicts that cross the math engine's boundaries.

These describe payloads that already exist and are already stable; nothing here
changes a runtime shape. They are declared as ``TypedDict`` so a reader (or a
port to another language) can see the field set and its element types without
tracing every producer.

Scope is deliberately narrow: only the shapes whose producer *and* consumer are
both in-tree and whose key set is fixed.

- :class:`VoteRecord` / :class:`VotesPayload` — what
  :func:`polismath.run_math_pipeline.fetch_votes` builds and
  :meth:`polismath.conversation.conversation.Conversation.update_votes` reads.
  Vote signs are already normalised to the Delphi convention (AGREE=+1,
  DISAGREE=-1, PASS=0) at that Postgres boundary; see
  :mod:`polismath.utils.vote_convention`.
- :class:`CommentRecord` / :class:`CommentsPayload` — the comment rows the same
  entrypoint builds.
- :class:`ModerationPayload` — the four moderation id lists
  ``Conversation.update_moderation`` consumes.

``created`` is ``int | None`` in the record types because the Postgres columns
are nullable and the producers pass ``None`` straight through rather than
substituting a sentinel.
"""

from typing import Any, TypedDict


class VoteRecord(TypedDict):
    """One vote as handed to ``Conversation.update_votes``.

    ``pid``/``tid`` are stringified at the fetch boundary (the engine keys its
    matrices by the string form); ``vote`` is a float in the Delphi convention;
    ``created`` is epoch milliseconds.
    """

    pid: str
    tid: str
    vote: float
    created: int | None


class VotesPayload(TypedDict, total=False):
    """The ``update_votes`` envelope.

    ``votes`` is always present. ``lastVoteTimestamp`` is optional — the
    consumer falls back to the conversation's own ``last_updated`` when it is
    absent — which is why this TypedDict is ``total=False``.
    """

    votes: list[VoteRecord]
    lastVoteTimestamp: int


class CommentRecord(TypedDict):
    """One comment row. ``txt`` is the raw body; ``created`` epoch millis."""

    tid: str
    created: int | None
    txt: str
    is_seed: bool


class CommentsPayload(TypedDict):
    """The comments envelope built alongside :class:`VotesPayload`."""

    comments: list[CommentRecord]


class ModerationPayload(TypedDict, total=False):
    """Moderation ids as consumed by ``Conversation.update_moderation``.

    The four id lists are always written together by the fetch boundary;
    ``lastModTimestamp`` is optional (the consumer keeps its existing value when
    it is absent), so this TypedDict is ``total=False``.

    ``mod`` uses the production convention: -1 moderated-out, 1 moderated-in.
    ``meta_tids`` mirrors ``comments.is_meta`` and is independent of ``mod``.
    """

    mod_out_tids: list[str]
    mod_in_tids: list[str]
    meta_tids: list[str]
    mod_out_ptpts: list[str]
    lastModTimestamp: Any
