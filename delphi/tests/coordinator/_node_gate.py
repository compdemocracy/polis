"""The Node reader job is required, not optional (step-4 plan S2, Correction 1).

D5's rule is that a skipped check is a failure. The real Node reader needs
`server/node_modules`, which a clean CI checkout does not have, so the earlier
`skipif(not SERVER_MODULES.exists())` marker turned a missing dependency into a
silent skip. S2's obligation is to run the Node D4 job unconditionally: absent
modules are a hard failure that CI must fix by provisioning the pinned server
modules, and the only way to skip is an explicit local diagnostic opt-out.
"""
import os

import pytest

from coordinator.conftest import ROOT

SERVER_MODULES = ROOT / "server/node_modules"
# The one escape hatch, and it must be set on purpose. Unset (CI, and the gate
# run) means the Node job is required.
_NODE_OPTIONAL = os.environ.get("P026_NODE_READER_OPTIONAL") == "1"


def require_node():
    """Pass when the real Node reader can run; otherwise fail (or, only under the
    explicit opt-out, skip). Never a silent skip in the default/CI profile."""
    if SERVER_MODULES.exists():
        return
    if _NODE_OPTIONAL:
        pytest.skip("server/node_modules absent and P026_NODE_READER_OPTIONAL=1 set "
                    "(diagnostic opt-out); this skip must never happen in CI")
    pytest.fail("server/node_modules is absent, so the required Node reader did not run. "
                "The step-4 plan S2 job is unconditional: provision the pinned server "
                "modules in CI. Set P026_NODE_READER_OPTIONAL=1 only for a local diagnostic run.")
