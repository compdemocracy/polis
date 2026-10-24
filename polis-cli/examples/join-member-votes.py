#!/usr/bin/env python3
"""Join one conversation's owner XID export and vote export to a member list.

All cells remain strings. No identities are inferred and vote values are unchanged.
"""
import argparse
import csv
import os
from pathlib import Path


def read(path, required):
    with Path(path).open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream, strict=True)
        headers = reader.fieldnames or []
        if len(headers) != len(set(headers)) or not required <= set(headers):
            raise ValueError("Missing or duplicate CSV headers")
        rows = list(reader)
        if any(None in row or None in row.values() for row in rows):
            raise ValueError("CSV row width does not match its header")
        return headers, rows


def index(rows, key):
    result = {}
    for row in rows:
        value = row[key]
        if not value or value in result:
            raise ValueError("Empty or duplicate join key; resolve it before joining")
        result[value] = row
    return result


def join(members_path, xids_path, votes_path, output):
    _, members = read(members_path, {"xid", "member_label"})
    _, xids = read(xids_path, {"pid", "xid"})
    headers, votes = read(votes_path, {"voter-id", "vote"})
    columns = ["xid", "member_label", "member_match"]
    if set(columns) & set(headers):
        raise ValueError("Vote export already contains a join output column")
    members = index(members, "xid")
    xids = index(xids, "pid")
    # Validate every input before creating a file; never overwrite an earlier join.
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=headers + columns)
        writer.writeheader()
        for vote in votes:
            xid = xids.get(vote["voter-id"], {}).get("xid", "")
            member = members.get(xid)
            writer.writerow({**vote, "xid": xid,
                             "member_label": member["member_label"] if member else "",
                             "member_match": "matched" if member is not None else
                             "no_member" if xid else "no_xid"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["members", "xids", "votes", "output"]:
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    try:
        join(args.members, args.xids, args.votes, args.output)
    except (ValueError, OSError, csv.Error) as error:
        parser.exit(2, f"Join refused: {type(error).__name__}. Check input headers, unique keys and output path.\n")


if __name__ == "__main__":
    main()
