"""Job-id resolution for the pipeline entry points (design §4.4).

Precedence: explicit CLI value > ``DELPHI_JOB_ID`` env (transition fallback —
kept for one phase while un-migrated callers still rely on env inheritance,
then removed) > auto-generated ``local-<uuid4>`` for dev runs.
"""

import os
import uuid
from typing import Optional

ENV_VAR = "DELPHI_JOB_ID"


def resolve_job_id(cli_value: Optional[str] = None) -> str:
    if cli_value:
        return cli_value
    from_env = os.environ.get(ENV_VAR)
    if from_env:
        return from_env
    return f"local-{uuid.uuid4()}"
