#!/usr/bin/env sh
# Runs Go tests with coverage for internal packages and fails below the threshold.
set -eu
THRESHOLD="${COVERAGE_MIN:-80}"
mkdir -p coverage
go test -race -covermode=atomic -coverprofile=coverage/go.out ./internal/...
TOTAL=$(go tool cover -func=coverage/go.out | awk '/^total:/ { sub("%", "", $3); print $3 }')
echo "Go coverage: ${TOTAL}% (minimum ${THRESHOLD}%)"
awk -v t="$TOTAL" -v m="$THRESHOLD" 'BEGIN { exit (t + 0 < m + 0) }' || {
  echo "Go coverage below ${THRESHOLD}%" >&2
  exit 1
}
