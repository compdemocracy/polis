#!/usr/bin/env python3
"""Run the FULL_PIPELINE reset's DynamoDB delete routine for one conversation.

    DYNAMODB_ENDPOINT=http://127.0.0.1:8481 python3 reset_step.py <zid>

Calls delete_dynamodb_data(zid) from delphi/umap_narrative/reset_conversation.py
unchanged (the routine run_delphi.py runs before every FULL_PIPELINE job), against
the recordings' DynamoDB Local, and prints one JSON line: the routine's return
value and every log line it wrote, with elapsed seconds and the endpoint
masked. Generated fixture only; boto3 is the one dependency.
"""
import json
import logging
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "delphi", "umap_narrative"))

import reset_conversation  # noqa: E402


class Capture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.lines = []

    def emit(self, record):
        msg = record.getMessage()
        msg = re.sub(r"\d+\.\d+s", "<s>", msg)
        msg = msg.replace(os.environ.get("DYNAMODB_ENDPOINT", "<unset>"), "<dynamodb>")
        self.lines.append(f"{record.levelname}: {msg}")


def main():
    zid = sys.argv[1]
    cap = Capture()
    reset_conversation.logger.addHandler(cap)
    reset_conversation.logger.setLevel(logging.DEBUG)
    os.environ.setdefault("AWS_ACCESS_KEY_ID", "generatedlocal")
    os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "generatedlocal")
    deleted = reset_conversation.delete_dynamodb_data(zid, None)
    print(json.dumps({"deleted_total": deleted, "log": cap.lines}))


if __name__ == "__main__":
    main()
