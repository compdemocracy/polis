#!/usr/bin/env bash

static_node_directories=( client-admin client-participation client-report )
yaml_files=( development.yaml schema.yaml )
js_files=( config.js )
config_directory=config
repo_egrep="(polisServer.git|polis.git).*(fetch)"
repo_root_directory=`git rev-parse --show-toplevel`

if ! git remote -v | grep -E $repo_egrep; then
    echo "Error! This script must be run in a 'polis' directory."
    echo "Please edit ${0} if you believe you should not be getting this error."
    exit 1
fi
