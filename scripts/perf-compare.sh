#!/usr/bin/env bash
#
# perf-compare.sh — Lighthouse performance comparison between branches
#
# Compares the client-participation-alpha page load performance across:
#   1. edge branch (current production baseline)
#   2. br/client-participation-beta branch (feature branch)
#   3. Production (https://pol.is) — no build needed, remote only
#
# Prerequisites:
#   - Node.js and npm
#   - lighthouse CLI:  npm install -g lighthouse
#   - Chrome/Chromium installed
#   - The Polis Docker stack running (make start) for API backend
#   - Clean git working tree (script checks for uncommitted changes)
#
# Usage:
#   ./scripts/perf-compare.sh [conversation_id] [num_runs]
#
# Examples:
#   ./scripts/perf-compare.sh                      # defaults: 2jztymipfp, 5 runs
#   ./scripts/perf-compare.sh 2jztymipfp 3         # 3 runs
#   ./scripts/perf-compare.sh my-convo-id 10       # custom conversation, 10 runs
#

set -euo pipefail

# ------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------
CONVERSATION_ID="${1:-2jztymipfp}"
NUM_RUNS="${2:-5}"
PREVIEW_PORT=4321
PREVIEW_HOST="http://localhost:${PREVIEW_PORT}"
PROD_URL="https://pol.is/alpha/${CONVERSATION_ID}"
LOCAL_URL="${PREVIEW_HOST}/${CONVERSATION_ID}"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT_DIR="${PROJECT_ROOT}/client-participation-alpha"
RESULTS_DIR="${PROJECT_ROOT}/perf-results"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_RUN_DIR="${RESULTS_DIR}/${TIMESTAMP}"

EDGE_BRANCH="edge"
BETA_BRANCH="br/client-participation-beta"

# Lighthouse categories and flags
LH_FLAGS=(
  --chrome-flags="--headless --no-sandbox --disable-gpu"
  --only-categories=performance
  --throttling-method=simulate
  --preset=desktop
  --quiet
)

# ------------------------------------------------------------------
# Color helpers
# ------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}ℹ ${NC}$*"; }
ok()    { echo -e "${GREEN}✔ ${NC}$*"; }
warn()  { echo -e "${YELLOW}⚠ ${NC}$*"; }
err()   { echo -e "${RED}✘ ${NC}$*" >&2; }
header() { echo -e "\n${BOLD}${CYAN}═══ $* ═══${NC}\n"; }

# ------------------------------------------------------------------
# Preflight checks
# ------------------------------------------------------------------
preflight() {
  header "Preflight Checks"

  # Check for lighthouse
  if ! command -v lighthouse &>/dev/null; then
    err "lighthouse CLI not found. Install with: npm install -g lighthouse"
    exit 1
  fi
  ok "lighthouse CLI found: $(lighthouse --version 2>/dev/null || echo 'unknown version')"

  # Check for jq (used for JSON parsing)
  if ! command -v jq &>/dev/null; then
    err "jq not found. Install with: brew install jq"
    exit 1
  fi
  ok "jq found"

  # Check git working tree is clean
  cd "$PROJECT_ROOT"
  if ! git diff --quiet HEAD 2>/dev/null; then
    err "Git working tree has uncommitted changes. Please commit or stash first."
    exit 1
  fi
  ok "Git working tree is clean"

  # Record starting branch so we can return to it
  ORIGINAL_BRANCH=$(git branch --show-current 2>/dev/null || git rev-parse --short HEAD)
  ok "Current branch: ${ORIGINAL_BRANCH}"

  # Verify both branches exist
  if ! git rev-parse --verify "$EDGE_BRANCH" &>/dev/null; then
    err "Branch '${EDGE_BRANCH}' not found"
    exit 1
  fi
  if ! git rev-parse --verify "$BETA_BRANCH" &>/dev/null; then
    err "Branch '${BETA_BRANCH}' not found"
    exit 1
  fi
  ok "Both branches exist: ${EDGE_BRANCH}, ${BETA_BRANCH}"

  # Check that Docker API backend is accessible
  if curl -sf --max-time 5 "http://localhost:5000/api/v3/testConnection" &>/dev/null \
     || curl -sf --max-time 5 "http://localhost/api/v3/testConnection" &>/dev/null; then
    ok "API backend is reachable"
  else
    warn "API backend may not be running. The local Astro preview needs the backend for SSR."
    warn "Make sure 'make start' or 'make DETACH=true start' is running."
    read -rp "Continue anyway? [y/N] " answer
    [[ "$answer" =~ ^[Yy] ]] || exit 1
  fi

  # Create results directory
  mkdir -p "$RESULTS_RUN_DIR"/{edge,beta,production}
  ok "Results directory: ${RESULTS_RUN_DIR}"

  echo ""
  info "Configuration:"
  info "  Conversation ID:  ${CONVERSATION_ID}"
  info "  Runs per target:  ${NUM_RUNS}"
  info "  Local URL:        ${LOCAL_URL}"
  info "  Production URL:   ${PROD_URL}"
  echo ""
}

# ------------------------------------------------------------------
# Build & preview helpers
# ------------------------------------------------------------------
build_and_preview() {
  local branch="$1"
  local label="$2"

  header "Building ${label} (${branch})"

  cd "$PROJECT_ROOT"
  git checkout "$branch"
  ok "Checked out ${branch}"

  cd "$CLIENT_DIR"

  info "Installing dependencies..."
  npm ci --silent 2>/dev/null || npm install --silent
  ok "Dependencies installed"

  info "Building Astro project..."
  npm run build 2>&1 | tail -5
  ok "Build complete"

  info "Starting preview server on port ${PREVIEW_PORT}..."
  start_preview_server
}

start_preview_server() {
  # Kill any existing process on the preview port
  kill_preview_server 2>/dev/null || true
  sleep 1

  cd "$CLIENT_DIR"

  # Start the Astro standalone server in background
  # The standalone build runs dist/server/entry.mjs directly
  INTERNAL_SERVICE_URL="http://localhost:5000/api/v3" \
  PUBLIC_SERVICE_URL="http://localhost/api/v3" \
  HOST=0.0.0.0 \
  PORT="${PREVIEW_PORT}" \
    node dist/server/entry.mjs &>/tmp/astro-preview-$$.log &
  PREVIEW_PID=$!

  # Wait for server to be ready (up to 30s)
  # NOTE: We check the actual conversation URL, not "/", because the Astro app
  # has no root route — only /:conversation_id — so "/" always returns 404.
  local retries=30
  while ! curl -so /dev/null --max-time 5 -w '%{http_code}' "${LOCAL_URL}" 2>/dev/null | grep -q '^[23]'; do
    retries=$((retries - 1))
    if [ $retries -le 0 ]; then
      err "Preview server failed to start within 30s. Log tail:"
      tail -20 /tmp/astro-preview-$$.log
      exit 1
    fi
    sleep 1
  done
  ok "Preview server running (PID: ${PREVIEW_PID})"
}

kill_preview_server() {
  if [ -n "${PREVIEW_PID:-}" ]; then
    kill "$PREVIEW_PID" 2>/dev/null || true
    wait "$PREVIEW_PID" 2>/dev/null || true
    unset PREVIEW_PID
  fi
  # Also kill anything else on the port as a safety net
  lsof -ti:"${PREVIEW_PORT}" 2>/dev/null | xargs kill 2>/dev/null || true
}

# ------------------------------------------------------------------
# Lighthouse runner
# ------------------------------------------------------------------
run_lighthouse() {
  local url="$1"
  local output_prefix="$2"
  local label="$3"
  local run_num="$4"

  info "  Run ${run_num}/${NUM_RUNS}: ${label}..."

  local lh_exit=0
  local stderr_file="${output_prefix}-run${run_num}-stderr.log"
  lighthouse "$url" \
    "${LH_FLAGS[@]}" \
    --output=json \
    --output=html \
    --output-path="${output_prefix}-run${run_num}" \
    2>"$stderr_file" \
    || lh_exit=$?

  if [ $lh_exit -ne 0 ]; then
    err "  Run ${run_num} FAILED (exit code: ${lh_exit})"
    if [ -s "$stderr_file" ]; then
      err "  Lighthouse stderr:"
      tail -10 "$stderr_file" >&2
    fi
    return 1
  fi

  rm -f "$stderr_file"
  ok "  Run ${run_num} complete"
}

run_all_lighthouse() {
  local url="$1"
  local output_dir="$2"
  local label="$3"

  header "Running Lighthouse: ${label}"
  info "URL: ${url}"
  info "Runs: ${NUM_RUNS}"
  echo ""

  local failures=0
  for i in $(seq 1 "$NUM_RUNS"); do
    if ! run_lighthouse "$url" "${output_dir}/lighthouse" "$label" "$i"; then
      failures=$((failures + 1))
    fi
  done

  if [ $failures -gt 0 ]; then
    warn "${failures}/${NUM_RUNS} runs failed for ${label}"
  else
    ok "All ${NUM_RUNS} runs complete for ${label}"
  fi
}

# ------------------------------------------------------------------
# Results extraction & comparison
# ------------------------------------------------------------------
extract_metrics() {
  local json_file="$1"

  # Extract key metrics from Lighthouse JSON
  jq -r '{
    performance_score: (.categories.performance.score * 100),
    fcp_ms: .audits["first-contentful-paint"].numericValue,
    lcp_ms: .audits["largest-contentful-paint"].numericValue,
    tbt_ms: .audits["total-blocking-time"].numericValue,
    cls: .audits["cumulative-layout-shift"].numericValue,
    si_ms: .audits["speed-index"].numericValue,
    tti_ms: (.audits["interactive"].numericValue // null)
  }' "$json_file" 2>/dev/null
}

compute_summary() {
  local results_subdir="$1"
  local label="$2"

  # Collect all JSON results
  local json_files=()
  for f in "${results_subdir}"/lighthouse-run*.report.json; do
    [ -f "$f" ] && json_files+=("$f")
  done

  if [ ${#json_files[@]} -eq 0 ]; then
    warn "No results found for ${label}"
    return
  fi

  # Extract metrics from each run and compute median/mean
  local scores=() fcps=() lcps=() tbts=() clss=() sis=()

  for f in "${json_files[@]}"; do
    local m
    m=$(extract_metrics "$f")
    scores+=($(echo "$m" | jq -r '.performance_score'))
    fcps+=($(echo "$m" | jq -r '.fcp_ms'))
    lcps+=($(echo "$m" | jq -r '.lcp_ms'))
    tbts+=($(echo "$m" | jq -r '.tbt_ms'))
    clss+=($(echo "$m" | jq -r '.cls'))
    sis+=($(echo "$m" | jq -r '.si_ms'))
  done

  # Write summary JSON using jq
  local summary_file="${results_subdir}/summary.json"
  jq -n \
    --arg label "$label" \
    --argjson scores "$(printf '%s\n' "${scores[@]}" | jq -s '.')" \
    --argjson fcps "$(printf '%s\n' "${fcps[@]}" | jq -s '.')" \
    --argjson lcps "$(printf '%s\n' "${lcps[@]}" | jq -s '.')" \
    --argjson tbts "$(printf '%s\n' "${tbts[@]}" | jq -s '.')" \
    --argjson clss "$(printf '%s\n' "${clss[@]}" | jq -s '.')" \
    --argjson sis "$(printf '%s\n' "${sis[@]}" | jq -s '.')" \
    '{
      label: $label,
      runs: ($scores | length),
      performance_score: { values: $scores, median: ($scores | sort | .[length/2 | floor]), mean: ($scores | add / length) },
      first_contentful_paint_ms: { values: $fcps, median: ($fcps | sort | .[length/2 | floor]), mean: ($fcps | add / length) },
      largest_contentful_paint_ms: { values: $lcps, median: ($lcps | sort | .[length/2 | floor]), mean: ($lcps | add / length) },
      total_blocking_time_ms: { values: $tbts, median: ($tbts | sort | .[length/2 | floor]), mean: ($tbts | add / length) },
      cumulative_layout_shift: { values: $clss, median: ($clss | sort | .[length/2 | floor]), mean: ($clss | add / length) },
      speed_index_ms: { values: $sis, median: ($sis | sort | .[length/2 | floor]), mean: ($sis | add / length) }
    }' > "$summary_file"

  ok "Summary written to ${summary_file}"
}

print_comparison_table() {
  header "Performance Comparison Results"

  local edge_summary="${RESULTS_RUN_DIR}/edge/summary.json"
  local beta_summary="${RESULTS_RUN_DIR}/beta/summary.json"
  local prod_summary="${RESULTS_RUN_DIR}/production/summary.json"

  # Helper to format a metric row
  fmt_row() {
    local metric_name="$1"
    local jq_path="$2"
    local unit="$3"
    local lower_is_better="${4:-true}"

    local edge_val beta_val prod_val
    edge_val=$(jq -r "${jq_path}.median // \"N/A\"" "$edge_summary" 2>/dev/null || echo "N/A")
    beta_val=$(jq -r "${jq_path}.median // \"N/A\"" "$beta_summary" 2>/dev/null || echo "N/A")
    prod_val=$(jq -r "${jq_path}.median // \"N/A\"" "$prod_summary" 2>/dev/null || echo "N/A")

    # Calculate delta between edge and beta
    local delta=""
    if [[ "$edge_val" != "N/A" && "$beta_val" != "N/A" ]]; then
      delta=$(echo "$beta_val - $edge_val" | bc 2>/dev/null || echo "")
      if [ -n "$delta" ]; then
        local sign=""
        local color=""
        # Determine if delta is positive or negative
        if (( $(echo "$delta > 0" | bc -l 2>/dev/null || echo 0) )); then
          sign="+"
          if [ "$lower_is_better" = "true" ]; then
            color="${RED}"  # worse
          else
            color="${GREEN}" # better (e.g., score)
          fi
        elif (( $(echo "$delta < 0" | bc -l 2>/dev/null || echo 0) )); then
          sign=""
          if [ "$lower_is_better" = "true" ]; then
            color="${GREEN}" # better
          else
            color="${RED}"   # worse
          fi
        else
          color="${NC}"
        fi
        delta="${color}${sign}$(printf '%.1f' "$delta")${unit}${NC}"
      fi
    fi

    # Format values
    if [[ "$edge_val" != "N/A" ]]; then
      edge_val=$(printf '%.1f' "$edge_val")
    fi
    if [[ "$beta_val" != "N/A" ]]; then
      beta_val=$(printf '%.1f' "$beta_val")
    fi
    if [[ "$prod_val" != "N/A" ]]; then
      prod_val=$(printf '%.1f' "$prod_val")
    fi

    printf "  %-28s %12s %12s %12s    %s\n" \
      "$metric_name" \
      "${prod_val}${unit}" \
      "${edge_val}${unit}" \
      "${beta_val}${unit}" \
      "${delta:-}"
  }

  echo -e "  Conversation: ${BOLD}${CONVERSATION_ID}${NC}"
  echo -e "  Runs per target: ${BOLD}${NUM_RUNS}${NC}"
  echo -e "  Medians shown (lower is better except Performance Score)"
  echo ""

  printf "  ${BOLD}%-28s %12s %12s %12s    %s${NC}\n" \
    "Metric" "Production" "edge (local)" "beta (local)" "Δ edge→beta"
  printf "  %-28s %12s %12s %12s    %s\n" \
    "----------------------------" "------------" "------------" "------------" "-----------"

  fmt_row "Performance Score"         ".performance_score"              ""    "false"
  fmt_row "First Contentful Paint"    ".first_contentful_paint_ms"      "ms"  "true"
  fmt_row "Largest Contentful Paint"  ".largest_contentful_paint_ms"    "ms"  "true"
  fmt_row "Total Blocking Time"       ".total_blocking_time_ms"         "ms"  "true"
  fmt_row "Speed Index"               ".speed_index_ms"                 "ms"  "true"
  fmt_row "Cumulative Layout Shift"   ".cumulative_layout_shift"        ""    "true"

  echo ""

  # Also generate a markdown version for easy sharing
  generate_markdown_report
}

generate_markdown_report() {
  local report_file="${RESULTS_RUN_DIR}/comparison-report.md"

  local edge_summary="${RESULTS_RUN_DIR}/edge/summary.json"
  local beta_summary="${RESULTS_RUN_DIR}/beta/summary.json"
  local prod_summary="${RESULTS_RUN_DIR}/production/summary.json"

  md_val() {
    local file="$1" path="$2" unit="$3"
    local val
    val=$(jq -r "${path}.median // \"N/A\"" "$file" 2>/dev/null || echo "N/A")
    if [[ "$val" != "N/A" ]]; then
      printf '%.1f%s' "$val" "$unit"
    else
      echo "N/A"
    fi
  }

  md_delta() {
    local edge_file="$1" beta_file="$2" path="$3" unit="$4"
    local e b
    e=$(jq -r "${path}.median // \"\"" "$edge_file" 2>/dev/null || echo "")
    b=$(jq -r "${path}.median // \"\"" "$beta_file" 2>/dev/null || echo "")
    if [[ -n "$e" && -n "$b" ]]; then
      local d
      d=$(echo "$b - $e" | bc 2>/dev/null || echo "")
      if [ -n "$d" ]; then
        local sign=""
        (( $(echo "$d > 0" | bc -l 2>/dev/null || echo 0) )) && sign="+"
        printf '%s%.1f%s' "$sign" "$d" "$unit"
      else
        echo "—"
      fi
    else
      echo "—"
    fi
  }

  {
    echo "# Performance Comparison Report"
    echo ""
    echo "- **Date**: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "- **Conversation**: \`${CONVERSATION_ID}\`"
    echo "- **Runs per target**: ${NUM_RUNS}"
    echo "- **Tool**: Lighthouse $(lighthouse --version 2>/dev/null || echo 'CLI')"
    echo "- **Mode**: Desktop preset, simulated throttling"
    echo ""
    echo "## Branches"
    echo ""
    echo "| Target | Branch / URL | Git SHA |"
    echo "|--------|-------------|---------|"
    cd "$PROJECT_ROOT"
    local edge_sha beta_sha
    edge_sha=$(git rev-parse --short "$EDGE_BRANCH" 2>/dev/null || echo "N/A")
    beta_sha=$(git rev-parse --short "$BETA_BRANCH" 2>/dev/null || echo "N/A")
    echo "| Production | ${PROD_URL} | (deployed) |"
    echo "| edge (local) | \`${EDGE_BRANCH}\` | \`${edge_sha}\` |"
    echo "| beta (local) | \`${BETA_BRANCH}\` | \`${beta_sha}\` |"
    echo ""
    echo "## Results (Median of ${NUM_RUNS} runs)"
    echo ""
    echo "| Metric | Production | edge (local) | beta (local) | Δ edge→beta |"
    echo "|--------|-----------|-------------|-------------|-------------|"

    for row in \
      "Performance Score|.performance_score|" \
      "First Contentful Paint|.first_contentful_paint_ms|ms" \
      "Largest Contentful Paint|.largest_contentful_paint_ms|ms" \
      "Total Blocking Time|.total_blocking_time_ms|ms" \
      "Speed Index|.speed_index_ms|ms" \
      "Cumulative Layout Shift|.cumulative_layout_shift|"; do

      IFS='|' read -r name path unit <<< "$row"
      printf '| %s | %s | %s | %s | %s |\n' \
        "$name" \
        "$(md_val "$prod_summary" "$path" "$unit")" \
        "$(md_val "$edge_summary" "$path" "$unit")" \
        "$(md_val "$beta_summary" "$path" "$unit")" \
        "$(md_delta "$edge_summary" "$beta_summary" "$path" "$unit")"
    done

    echo ""
    echo "## Individual Run Scores"
    echo ""
    for target in production edge beta; do
      local sf="${RESULTS_RUN_DIR}/${target}/summary.json"
      if [ -f "$sf" ]; then
        local vals
        vals=$(jq -r '.performance_score.values | map(tostring) | join(", ")' "$sf" 2>/dev/null || echo "N/A")
        echo "- **${target}**: ${vals}"
      fi
    done

    echo ""
    echo "## Notes"
    echo ""
    echo "- Local runs used the Astro standalone preview server (SSR) with the Docker API backend."
    echo "- Production results include network latency and CDN effects; local results do not."
    echo "- The Δ column shows the change from edge→beta. Negative values for timing metrics indicate improvement."
    echo ""
    echo "---"
    echo "*Generated by \`scripts/perf-compare.sh\`*"
  } > "$report_file"

  ok "Markdown report: ${report_file}"
}

# ------------------------------------------------------------------
# Cleanup trap
# ------------------------------------------------------------------
cleanup() {
  info "Cleaning up..."
  kill_preview_server 2>/dev/null || true

  # Return to original branch
  if [ -n "${ORIGINAL_BRANCH:-}" ]; then
    cd "$PROJECT_ROOT"
    git checkout "$ORIGINAL_BRANCH" 2>/dev/null || true
    ok "Restored branch: ${ORIGINAL_BRANCH}"
  fi
}
trap cleanup EXIT

# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------
main() {
  echo ""
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║   Polis Client Performance Comparison            ║${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${NC}"
  echo ""

  preflight

  # ── Phase 1: Production baseline ──
  run_all_lighthouse "$PROD_URL" "${RESULTS_RUN_DIR}/production" "Production (pol.is)"

  # ── Phase 2: edge branch (local) ──
  build_and_preview "$EDGE_BRANCH" "edge"
  run_all_lighthouse "$LOCAL_URL" "${RESULTS_RUN_DIR}/edge" "edge (local)"
  kill_preview_server
  ok "Preview server stopped"

  # ── Phase 3: beta branch (local) ──
  build_and_preview "$BETA_BRANCH" "beta"
  run_all_lighthouse "$LOCAL_URL" "${RESULTS_RUN_DIR}/beta" "beta (local)"
  kill_preview_server
  ok "Preview server stopped"

  # ── Phase 4: Compute & display results ──
  compute_summary "${RESULTS_RUN_DIR}/edge" "edge (local)"
  compute_summary "${RESULTS_RUN_DIR}/beta" "beta (local)"
  compute_summary "${RESULTS_RUN_DIR}/production" "Production (pol.is)"

  print_comparison_table

  echo ""
  ok "Full results in: ${RESULTS_RUN_DIR}/"
  ok "HTML reports available for detailed review in each subdirectory."
  info "Open any .report.html file in a browser for the full Lighthouse report."
  echo ""
}

main
