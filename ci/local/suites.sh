# The suite lists (sourced by check.sh and changed-suites.sh).
#
# GATE: every check hosted CI runs on a pull request to edge, in the order of
# the workflows (Server Integration Tests: golden guard, contracts, jest; E2E;
# the coordinator campaign; the vote convention gate: lint, two conventions;
# Delphi characterization; Collective statement recordings: guard, replay;
# routing recordings; Lint; Delphi Python; queue-rs; the three clients; Test
# Math). Path-filtered workflows are included: `make check` answers "would
# every check pass", whatever changed.
CHECK_GATE_SUITES="vote-path-guard contracts server-integration e2e coordinator vote-sign-lint vote-gate delphi-characterization collective-statement-guard collective-statement routing-recordings lint delphi-python queue-rs client-alpha client-admin client-report math"
# FAST: the fast-loop tier: seconds, no containers, no image builds.
CHECK_FAST_SUITES="selector-test vote-sign-lint vote-path-guard collective-statement-guard contracts server-unit lint"
# UNGATED: test sets no workflow runs yet. Entry points exist; nothing gates on them.
CHECK_UNGATED_SUITES="client-participation cdk ci-python"
# TOOLING: fast, no-container checks for the local check harness itself.
CHECK_TOOLING_SUITES="selector-test"
CHECK_ALL_SUITES="$CHECK_GATE_SUITES server-unit $CHECK_UNGATED_SUITES $CHECK_TOOLING_SUITES"
