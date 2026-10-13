#!/usr/bin/env bash
# The ONE quality gate. The Stop hook, CI and humans all run exactly this.
# Human-owned: Claude cannot edit it (devkit guard). Adjust per stack, then `devkit doctor`.
# Exit non-zero on any failure. Keep it under ~2 minutes; put slow suites in CI only.
set -uo pipefail
cd "$(dirname "$0")"
fail=0
step() { echo "== $1"; shift; if ! "$@"; then echo "FAILED: $*"; fail=1; fi; }
has_script() { [ -f package.json ] && node -e "process.exit(require('./package.json').scripts?.['$1']?0:1)" 2>/dev/null; }

# --- JS / TS ---
if [ -f package.json ]; then
  has_script typecheck && step typecheck npm run -s typecheck
  has_script lint      && step lint      npm run -s lint
  has_script test      && step test      npm test --silent
fi

# --- Python ---
# Prints DEVKIT_TESTS_RAN_PY=<n>; the Stop gate fails if fewer tests ran than are defined,
# so a runner that silently skips files (discovery, naming, pytest-only style) cannot pass.
if git ls-files -co --exclude-standard 2>/dev/null | grep -qE '(^|/)(test_[^/]*|[^/]*_test)\.py$'; then
  if python3 -c "import pytest" 2>/dev/null; then
    echo "== pytest"
    out=$(python3 -m pytest -q -p no:cacheprovider 2>&1); rc=$?
    echo "$out" | tail -25
    summary=$(echo "$out" | grep -E '[0-9]+ (passed|failed)' | tail -1)
    ran=0; for k in passed failed error errors xfailed xpassed; do
      n=$(echo "$summary" | grep -oE "[0-9]+ $k\b" | grep -oE '^[0-9]+'); ran=$((ran + ${n:-0})); done
    echo "DEVKIT_TESTS_RAN_PY=$ran"
    [ $rc -ne 0 ] && { echo "FAILED: pytest"; fail=1; }
  else
    echo "== unittest (pytest not installed)"
    ran=0
    # discover per folder: Python 3.9 skips folders without __init__.py when discovering from the root
    dirs=$(git ls-files -z -co --exclude-standard | tr '\0' '\n' | grep -E '(^|/)(test_[^/]*|[^/]*_test)\.py$' \
           | sed -E 's|/[^/]*$||; s|^[^/]*\.py$|.|' | sort -u)
    while IFS= read -r d; do
      [ -z "$d" ] && continue
      for pat in 'test_*.py' '*_test.py'; do
        out=$(python3 -m unittest discover -s "$d" -p "$pat" 2>&1); rc=$?
        n=$(echo "$out" | grep -oE '^Ran [0-9]+ test' | grep -oE '[0-9]+'); ran=$((ran + ${n:-0}))
        if [ $rc -ne 0 ] && [ $rc -ne 5 ]; then echo "$out" | tail -25; echo "FAILED: unittest $d ($pat)"; fail=1; fi
      done
    done <<< "$dirs"
    echo "unittest: $ran tests ran"
    echo "DEVKIT_TESTS_RAN_PY=$ran"
  fi
  defined=$(git ls-files -z -co --exclude-standard | tr '\0' '\n' | grep -E '(^|/)(test_[^/]*|[^/]*_test)\.py$' \
            | while IFS= read -r f; do grep -cE '^[[:space:]]*(async[[:space:]]+)?def[[:space:]]+test' "$f"; done | awk '{s+=$1} END {print s+0}')
  if [ "${ran:-0}" -lt "$defined" ]; then
    echo "FAILED: $defined Python tests defined but only ${ran:-0} ran (pytest-style tests need pytest; check discovery)"; fail=1
  fi
  command -v ruff >/dev/null && step ruff ruff check .
  if command -v bandit >/dev/null; then step bandit bandit -q -r . -x ./tests,./.venv,./node_modules -ll
  else echo "== bandit not installed (pip install bandit); CI runs it"; fi
fi

# --- Flow graph: every transition and edge case mapped to a real test ---
if [ -f docs/flows.json ]; then
  DEVKIT=$(command -v devkit || ls "$HOME/projects/devkit/bin/devkit" 2>/dev/null)
  if [ -n "$DEVKIT" ]; then step flows "$DEVKIT" flows --strict
  else echo "== flows SKIPPED (devkit not installed here, e.g. CI); run locally"; fi
fi

# --- Security (OWASP Top 10:2025 A03 supply chain, A05 injection, secrets). research/08-security.md ---
missing=""
if command -v gitleaks >/dev/null; then step gitleaks gitleaks detect --no-banner --redact -q; else missing="$missing gitleaks"; fi
if command -v semgrep >/dev/null; then step semgrep semgrep scan --config auto --error --quiet --exclude tests --exclude node_modules
else missing="$missing semgrep"; fi
if command -v osv-scanner >/dev/null; then
  echo "== osv-scanner"; osv-scanner scan source -r . ; rc=$?
  # 0 clean, 1 vulnerabilities, 128 no lockfiles found (nothing to scan)
  if [ $rc -ne 0 ] && [ $rc -ne 128 ]; then echo "FAILED: osv-scanner ($rc)"; fail=1; fi
else
  [ -f package-lock.json ] && step npm-audit npm audit --audit-level=high --omit=dev
  if [ -f requirements.txt ]; then
    if command -v pip-audit >/dev/null; then step pip-audit pip-audit -r requirements.txt; else missing="$missing pip-audit"; fi
  fi
  [ -f package.json ] && [ ! -f package-lock.json ] && echo "== npm audit skipped: no package-lock.json (commit a lockfile)"
  missing="$missing osv-scanner"
fi
# Fail on Python security smells when bandit is present (SQL built from strings, shell=True, pickle, ...)
[ -n "$missing" ] && echo "== security tools not installed:$missing (brew install gitleaks semgrep osv-scanner); CI runs them"

[ $fail -eq 0 ] && echo "GATE: GREEN" || echo "GATE: RED"
exit $fail
