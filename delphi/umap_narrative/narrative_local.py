"""
Run the narrative report's prompts against a local Ollama model.

The hosted path (801 with LLM_PROVIDER=anthropic) submits every section to the
Anthropic Message Batches API and leaves the results to the 803 checker job.
With LLM_PROVIDER=ollama there is no batch: 801 sends the same prompts, in the
same order, one at a time by default, and stores each section as it completes,
in the same NarrativeReports shape the checker writes. The job then completes
inline, with no batch id and no checker row.

Knobs (all optional):

* ``OLLAMA_NARRATIVE_CONCURRENCY`` - requests in flight at once (default 1).
* ``OLLAMA_REQUEST_TIMEOUT_SECONDS`` - per-request timeout (default 600).
* ``OLLAMA_NARRATIVE_JOB_TIMEOUT_SECONDS`` - wall-clock budget for the whole
  job (default 3000, under the poller's 3600 s default). Requests that would
  start after the budget is spent are not sent, and the job fails.
* ``OLLAMA_NUM_CTX`` - context window passed to Ollama (default 16384). The
  narrative prompts carry up to 100 comments as XML; Ollama's own default
  window would silently truncate them.
"""

import json
import logging
import os
import re
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

PROVIDER_OLLAMA = "ollama"

DEFAULT_CONCURRENCY = 1
DEFAULT_REQUEST_TIMEOUT_SECONDS = 600.0
DEFAULT_JOB_TIMEOUT_SECONDS = 3000.0
DEFAULT_NUM_CTX = 16384


class MalformedNarrativeOutput(ValueError):
    """The model's text is not a narrative section in the expected JSON shape."""


def _env_number(name: str, default, cast, minimum):
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = cast(raw)
    except ValueError:
        logger.warning(f"{name}={raw!r} is not a number; using {default}")
        return default
    if value < minimum:
        logger.warning(f"{name}={raw!r} is below {minimum}; using {default}")
        return default
    return value


@dataclass
class LocalRunSettings:
    concurrency: int = DEFAULT_CONCURRENCY
    request_timeout: float = DEFAULT_REQUEST_TIMEOUT_SECONDS
    job_timeout: float = DEFAULT_JOB_TIMEOUT_SECONDS
    num_ctx: int = DEFAULT_NUM_CTX

    @classmethod
    def from_env(cls) -> "LocalRunSettings":
        return cls(
            concurrency=_env_number("OLLAMA_NARRATIVE_CONCURRENCY", DEFAULT_CONCURRENCY, int, 1),
            request_timeout=_env_number("OLLAMA_REQUEST_TIMEOUT_SECONDS", DEFAULT_REQUEST_TIMEOUT_SECONDS, float, 1),
            job_timeout=_env_number("OLLAMA_NARRATIVE_JOB_TIMEOUT_SECONDS", DEFAULT_JOB_TIMEOUT_SECONDS, float, 1),
            num_ctx=_env_number("OLLAMA_NUM_CTX", DEFAULT_NUM_CTX, int, 512),
        )


@dataclass
class LocalRunResult:
    stored: List[str] = field(default_factory=list)  # section names, completion order
    failures: Dict[str, str] = field(default_factory=dict)  # section name -> reason

    @property
    def ok(self) -> bool:
        return bool(self.stored) and not self.failures

    def summary(self) -> str:
        total = len(self.stored) + len(self.failures)
        if not self.failures:
            return f"{len(self.stored)} of {total} sections generated"
        first_section, first_reason = next(iter(self.failures.items()))
        return (
            f"{len(self.failures)} of {total} sections failed on the local model "
            f"(first: {first_section}: {first_reason})"
        )


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def parse_narrative_json(text: str) -> Dict[str, Any]:
    """Parse a section the way the report reads it: one JSON object with a
    ``paragraphs`` list. Code fences and stray text around the object are
    tolerated; anything else raises MalformedNarrativeOutput."""
    if not isinstance(text, str) or not text.strip():
        raise MalformedNarrativeOutput("empty output")
    candidate = _FENCE.sub("", text.strip()).strip()
    try:
        parsed = json.loads(candidate)
    except ValueError:
        start, end = candidate.find("{"), candidate.rfind("}")
        if start < 0 or end <= start:
            raise MalformedNarrativeOutput("output is not JSON")
        try:
            parsed = json.loads(candidate[start : end + 1])
        except ValueError as e:
            raise MalformedNarrativeOutput(f"output is not valid JSON ({e.msg})")
    if not isinstance(parsed, dict) or not isinstance(parsed.get("paragraphs"), list):
        raise MalformedNarrativeOutput("JSON has no 'paragraphs' list")
    return parsed


def run_requests_locally(
    requests_: List[Dict[str, Any]],
    *,
    chat: Callable[..., str],
    section_for: Callable[[Dict[str, Any]], str],
    store: Callable[[Dict[str, Any], str, str], bool],
    store_error: Callable[[Dict[str, Any], str, str], None],
    settings: LocalRunSettings,
    clock: Callable[[], float] = time.monotonic,
) -> LocalRunResult:
    """Send each prepared request to ``chat`` and store the parsed section.

    ``requests_`` are the dicts 801's ``prepare_batch_requests`` builds
    (``system``, ``messages[0].content``, ``max_tokens``, ``metadata``).
    ``chat(system, user, max_tokens=, timeout=, num_ctx=)`` returns text or
    raises. ``store(request, section, content)`` returns False when the write
    did not land. ``store_error(request, section, reason)`` writes a visible
    placeholder for a failed section. Sections are stored in completion order.

    Placeholders are written only after at least one section was stored. A run
    in which every section fails writes nothing, so the report keeps showing
    the previous run (it shows the newest job that has rows) instead of a run
    made only of error sections.
    """
    result = LocalRunResult()
    failed: List[tuple] = []
    deadline = clock() + settings.job_timeout
    pending = list(requests_)

    def one(request: Dict[str, Any]):
        section = section_for(request)
        remaining = deadline - clock()
        if remaining <= 0:
            return request, section, None, "not sent: the job's time budget was spent"
        timeout = min(settings.request_timeout, remaining)
        try:
            text = chat(
                request.get("system", ""),
                request["messages"][0]["content"],
                max_tokens=request.get("max_tokens", 8000),
                timeout=timeout,
                num_ctx=settings.num_ctx,
            )
            parsed = parse_narrative_json(text)
            return request, section, json.dumps(parsed), None
        except Exception as e:  # noqa: BLE001 - every failure is recorded per section
            return request, section, None, str(e) or e.__class__.__name__

    def record(request, section, content, error):
        if error is None:
            if store(request, section, content):
                result.stored.append(section)
                logger.info(f"Stored local-model section {section}")
                return
            error = "the section could not be written to NarrativeReports"
        logger.error(f"Local-model section {section} failed: {error}")
        result.failures[section] = error
        failed.append((request, section, error))

    workers = max(1, settings.concurrency)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        in_flight = set()
        while pending or in_flight:
            while pending and len(in_flight) < workers:
                in_flight.add(pool.submit(one, pending.pop(0)))
            done, in_flight = wait(in_flight, return_when=FIRST_COMPLETED)
            for future in done:
                record(*future.result())

    if not result.stored:
        if failed:
            logger.error("No section was generated; writing nothing, so the previous run stays visible")
        return result
    for request, section, error in failed:
        try:
            store_error(request, section, error)
        except Exception as e:  # noqa: BLE001
            logger.error(f"Could not store the error placeholder for {section}: {e}")
    return result
