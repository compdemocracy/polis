#!/bin/bash
set -e
set -x

# Stop any existing Docker containers (if needed)
# Docker's `name` filter is an unanchored regex (a substring match), so
# `name=polis-math` also matches the Delphi box's `polis-math-python-1` and the
# hook then tried to stop a `polis-math-1` that only exists on the math box.
# Anchor every filter to the exact container name; the optional leading `/`
# covers daemons that match against the stored `/name` form.
if docker ps -q --filter "name=^/?polis-server-1$" | grep -q .; then
    docker stop polis-server-1
fi
if docker ps -q --filter "name=^/?polis-math-1$" | grep -q .; then
    docker stop polis-math-1
fi
if docker ps -q --filter "name=^/?polis-delphi-1$" | grep -q .; then
    docker stop polis-delphi-1
fi
