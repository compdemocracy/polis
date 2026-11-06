#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -m unittest discover -s ci -p test_host_ports.py -v
python3 -m unittest discover -s server/characterization -p test_isolation.py -v
python3 -m unittest discover -s ci/probe_box -p test_reversal_fixture.py -v
