import os

# import subprocess # No longer needed
import sys

# Import the main function from job_poller using package import
# This requires delphi/scripts/__init__.py to exist
from scripts.job_poller import main as job_poller_main

# Get the directory of this script
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_SUBDIR = os.path.join(SCRIPT_DIR, "scripts")

# Path to the Python poller script (for argv[0] and potentially for job_poller itself if it uses __file__)
POLLER_SCRIPT_PATH = os.path.join(SCRIPTS_SUBDIR, "job_poller.py")

# Default options
ENDPOINT_URL = os.environ.get("DYNAMODB_ENDPOINT", "http://localhost:8000")
POLL_INTERVAL = os.environ.get("POLL_INTERVAL", "10")
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")
MAX_WORKERS = os.environ.get("MAX_WORKERS", "1")

# Colors for output
GREEN = "\\033[0;32m"
YELLOW = "\\033[0;33m"
NC = "\\033[0m"  # No Color

print(f"{GREEN}Starting Delphi Job Poller Service (Python Direct Call){NC}")
print(f"{YELLOW}DynamoDB Endpoint:{NC} {ENDPOINT_URL}")
print(f"{YELLOW}Poll Interval:{NC} {POLL_INTERVAL} seconds")
print(f"{YELLOW}Log Level:{NC} {LOG_LEVEL}")
print(f"{YELLOW}Max Workers:{NC} {MAX_WORKERS}")
print("")

# Collect additional arguments passed to this script
additional_args_from_caller = sys.argv[1:]

# Construct the arguments list for job_poller.main()
# sys.argv[0] should be the script name
poller_argv = [
    POLLER_SCRIPT_PATH,  # Argv[0] is the script name for job_poller's argparse
    f"--endpoint-url={ENDPOINT_URL}",
    f"--interval={POLL_INTERVAL}",
    f"--log-level={LOG_LEVEL}",
    f"--max-workers={MAX_WORKERS}",
] + additional_args_from_caller

# Store original sys.argv and set the new one for job_poller.main
original_argv = sys.argv
sys.argv = poller_argv

try:
    # Call job_poller's main function
    # job_poller.main() will handle its own exceptions and sys.exit calls
    job_poller_main()
    # If job_poller_main exits normally (without sys.exit), exit code will be 0
    # If job_poller_main calls sys.exit(N), that will be the exit code.
except Exception as e:
    # This catch is a fallback, job_poller.main should handle its own errors.
    print(f"Unexpected error calling job_poller.main(): {e}", file=sys.stderr)
    sys.exit(1)
finally:
    # Restore original sys.argv (good practice, though script exits here)
    sys.argv = original_argv
