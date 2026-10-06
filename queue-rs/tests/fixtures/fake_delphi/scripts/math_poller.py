"""Generated fixture standing in for delphi/scripts/math_poller.py --job: see fake_child.py."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fake_child import main  # noqa: E402

sys.exit(main("math_poller"))
