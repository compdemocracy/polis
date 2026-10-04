"""Generated fixture: see fake_child.py."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))) if "umap_narrative" in __file__ else os.path.dirname(os.path.abspath(__file__)))
from fake_child import main  # noqa: E402

sys.exit(main("run"))
