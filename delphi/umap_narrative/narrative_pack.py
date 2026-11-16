"""Narrative prompt packs: Delphi's own narrative prompts for a report, with no model call.

A pack is what an outside agent needs to write a report narrative with its own
model from exactly the prompts Delphi's narrative batch would send: for every
section that batch would request (each topic of every layer, and the three
global sections), the request itself (`system`, the user message,
`max_tokens`), built by `BatchReportGenerator.prepare_batch_requests` in
801_narrative_report_batch.py, the comments the section shows the model (read
back from that request, so they are exactly what the model is given) and the
comment ids it may cite. No provider is imported or called.

The server's narrative export serves the newest stored pack for a report while
the pack's inputs are still the conversation's (pd_narrative_source_state:
the math tick, the comment set and the vote high-water mark, in the shape of
the run record's inputs) and its topics are still the topics Delphi serves.
The pack is stored with pd_narrative_pack_put (migration 000046).

    python -m umap_narrative.narrative_pack --zid 123 --report-id r123abc --env <queue env>

Vote counts in a pack are the counts Delphi's narrative step reads, agree as
agree: they come from GroupDataProcessor.get_export_data, which reads votes
through Delphi's vote convention module, and no sign is converted here.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import importlib
import io
import json
import os
import sys
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Optional

import xmltodict

PACK_SCHEMA = "polis-narrative-pack/1"
# The version of the prompt pack's meaning: the narrative prompts as
# 801_narrative_report_batch.py builds them today. A change to the prompt files
# or to the prompt code changes prompt_files_sha256 or code_version, which are
# recorded with every pack; a change to what the prompts ask is a new version.
PROMPT_VERSION = "narrative/1"
# BatchReportGenerator requires a model name at construction. Preparing the
# requests never reads it, and this module never sends one.
NO_MODEL = "prompt-pack-no-model-call"

HERE = Path(__file__).resolve().parent
PROMPT_DIR = HERE / "report_experimental"
CODE_FILES = ("801_narrative_report_batch.py", "narrative_data.py", "narrative_pack.py")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def prompt_files_sha256(base: Path = PROMPT_DIR) -> str:
    """sha256 over one line per prompt file, sorted by path: ``<path>\\t<sha256>\\n``."""
    lines = []
    for path in sorted(p for p in base.rglob("*.xml") if p.is_file()):
        lines.append(f"{path.relative_to(base).as_posix()}\t{_sha256(path.read_bytes())}\n")
    return _sha256("".join(lines).encode("utf-8"))


def code_version(base: Path = HERE) -> str:
    """sha256 over the prompt code itself, in the same line form."""
    return _sha256("".join(f"{name}\t{_sha256((base / name).read_bytes())}\n" for name in CODE_FILES).encode("utf-8"))


def request_prompt_sha256(request: Dict[str, Any]) -> str:
    """The digest an agent can state for one section: the system text, a NUL, the user message."""
    return _sha256(request["system"].encode("utf-8") + b"\0" + request["messages"][0]["content"].encode("utf-8"))


def comments_xml_of(request: Dict[str, Any]) -> str:
    """The comments XML a prepared request carries, read back from the request.

    The user message starts with the prompt XML (801 unparses the template
    with the comments as the text of data/content/structured_comments) and
    then the JSON instructions; the XML block is parsed and the comments
    element's text is returned exactly as the model receives it, unescaped.
    """
    content = request["messages"][0]["content"]
    start = content.index("<?xml")
    end_tag = "</polisAnalysisPrompt>"
    end = content.index(end_tag, start) + len(end_tag)
    parsed = xmltodict.parse(content[start:end])
    return parsed["polisAnalysisPrompt"]["data"]["content"]["structured_comments"]


def parse_comments(comments_xml: str) -> List[Dict[str, Any]]:
    """The comments of a section's XML, with the counts the model is shown."""
    root = ET.fromstring(comments_xml)
    out = []
    for element in root.findall("comment"):
        counts = {name: int(element.get(name, "0") or 0) for name in ("votes", "agrees", "disagrees", "passes")}
        groups = {}
        for child in element:
            if child.tag.startswith("group-"):
                groups[child.tag[len("group-"):]] = {
                    name: int(child.get(name, "0") or 0) for name in ("votes", "agrees", "disagrees", "passes")
                }
        text = element.find("text")
        out.append({"id": int(element.get("id")), "text": (text.text if text is not None else "") or "",
                    **counts, "groups": groups})
    return out


def comments_csv(comments: List[Dict[str, Any]]) -> str:
    """The same comments as CSV, one column per group count."""
    groups = sorted({g for c in comments for g in c["groups"]}, key=lambda g: (len(g), g))
    header = ["comment_id", "comment_text", "votes", "agrees", "disagrees", "passes"]
    for g in groups:
        header += [f"group-{g}-{name}" for name in ("votes", "agrees", "disagrees", "passes")]
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(header)
    for c in comments:
        row = [c["id"], c["text"], c["votes"], c["agrees"], c["disagrees"], c["passes"]]
        for g in groups:
            counts = c["groups"].get(g, {})
            row += [counts.get(name, 0) for name in ("votes", "agrees", "disagrees", "passes")]
        writer.writerow(row)
    return buffer.getvalue()


def section_of(request: Dict[str, Any]) -> Dict[str, Any]:
    """One pack section from one prepared request."""
    metadata = request["metadata"]
    xml = comments_xml_of(request)
    comments = parse_comments(xml)
    topic_key = metadata.get("topic_key")
    is_topic = isinstance(topic_key, str) and "#" in topic_key
    return {
        "section": metadata["section_name"],
        "kind": "topic" if is_topic else "global",
        "topic_key": topic_key if is_topic else None,
        "topic_name": metadata.get("topic_name"),
        "request": {"system": request["system"], "messages": request["messages"], "max_tokens": request["max_tokens"]},
        "prompt_sha256": request_prompt_sha256(request),
        "comments_xml": xml,
        "comments_csv": comments_csv(comments),
        "citation_ids": [c["id"] for c in comments],
        "comments": comments,
    }


def build_pack(requests: List[Dict[str, Any]], *, zid: int, report_id: str, pack_id: str,
               inputs: Dict[str, Any], settings: Dict[str, Any]) -> Dict[str, Any]:
    """The pack document: every prepared request as a section, in Delphi's order."""
    if not requests:
        raise ValueError("Delphi prepared no narrative requests for this conversation")
    sections = [section_of(r) for r in requests]
    names = [s["section"] for s in sections]
    if len(set(names)) != len(names):
        raise ValueError("Delphi prepared two sections with the same name")
    labels = sorted({s["topic_key"].split("#", 1)[0] for s in sections if s["topic_key"]})
    return {
        "schema": PACK_SCHEMA,
        "pack_id": pack_id,
        "zid": str(int(zid)),
        "report_id": report_id,
        "prompt_version": PROMPT_VERSION,
        "prompt_files_sha256": prompt_files_sha256(),
        "code_version": code_version(),
        "inputs": inputs,
        "clustering": {"labels": labels},
        "settings": settings,
        "model_called": False,
        "sections": sections,
    }


def _batch_module():
    sys.path.insert(0, str(HERE))
    return importlib.import_module("umap_narrative.801_narrative_report_batch")


def generator_for(zid: int, pack_id: str, include_moderation: bool, exclude_comment_selections: bool):
    """Delphi's own narrative request builder for the conversation, with no model."""
    return _batch_module().BatchReportGenerator(
        conversation_id=zid, model=NO_MODEL, job_id=pack_id,
        include_moderation=include_moderation, exclude_comment_selections=exclude_comment_selections,
    )


def source_state(client, zid: int, math_env: Optional[str]) -> Dict[str, Any]:
    """The inputs the server judges a pack's freshness by, read now."""
    from sqlalchemy import text

    client.initialize()
    with client.engine.begin() as conn:
        return conn.execute(text("SELECT public.pd_narrative_source_state(:zid, :math_env) AS v"),
                            {"zid": zid, "math_env": math_env}).scalar_one()


def prepare_after_inputs(generator, zid: int, math_env: Optional[str]):
    """The inputs, then the requests. Read in this order, a conversation that
    changes while the requests are prepared leaves a pack whose inputs are
    older than the conversation, which the server refuses as stale; read the
    other way round, the pack would carry the newer inputs over the older
    prompts and be served as fresh. No provider is called."""
    inputs = source_state(generator.postgres_client, zid, math_env)
    return inputs, asyncio.run(generator.prepare_batch_requests())


async def prepare(zid: int, pack_id: str, include_moderation: bool, exclude_comment_selections: bool):
    """Delphi's own narrative requests for the conversation. No provider is called."""
    generator = generator_for(zid, pack_id, include_moderation, exclude_comment_selections)
    return await generator.prepare_batch_requests(), generator


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Store Delphi's narrative prompts for a report, with no model call")
    parser.add_argument("--zid", type=int, required=True)
    parser.add_argument("--report-id", required=True)
    parser.add_argument("--env", default=os.environ.get("QUEUE_ENV") or os.environ.get("DELPHI_RESULT_ENV"),
                        help="The job tables' env (default QUEUE_ENV, then DELPHI_RESULT_ENV)")
    parser.add_argument("--include-moderation", default="true", choices=["true", "false"],
                        help="Drop rejected comments, as the narrative job does (default true)")
    parser.add_argument("--exclude-comment-selections", default="true", choices=["true", "false"])
    args = parser.parse_args(argv)
    if not args.env:
        parser.error("--env is required (or set QUEUE_ENV)")
    os.environ.pop("ANTHROPIC_API_KEY", None)  # nothing here may reach a provider
    from polismath.components.config import ConfigManager

    pack_id = str(uuid.uuid4())
    include_moderation = args.include_moderation == "true"
    exclude = args.exclude_comment_selections == "true"
    generator = generator_for(args.zid, pack_id, include_moderation, exclude)
    math_env = ConfigManager.get_config().get("math-env")
    inputs, requests = prepare_after_inputs(generator, args.zid, math_env)
    client = generator.postgres_client
    client.initialize()
    from sqlalchemy import text

    pack = build_pack(requests, zid=args.zid, report_id=args.report_id, pack_id=pack_id, inputs=inputs,
                      settings={"include_moderation": include_moderation, "exclude_comment_selections": exclude})
    with client.engine.begin() as conn:
        receipt = conn.execute(
            text("SELECT public.pd_narrative_pack_put(:env, :zid, :report, CAST(:pack AS jsonb), :code) AS v"),
            {"env": args.env, "zid": args.zid, "report": args.report_id, "pack": json.dumps(pack),
             "code": pack["code_version"]}).scalar_one()
    client.shutdown()
    print(json.dumps({**receipt, "sections": len(pack["sections"]), "model_called": False}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
