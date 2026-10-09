#!/bin/bash
set -eu
# Keep the healthy revision running until AfterInstall has migrated successfully.
# CodeDeploy executes ApplicationStop from the PREVIOUS successful revision; see
# docs/upgrading.md for the one-time transition from the old stopping hook.
echo "Service shutdown is deferred until migrations succeed in AfterInstall."
