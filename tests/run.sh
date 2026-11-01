#!/bin/bash
# Runs the plugin's tests with macOS's built-in JavaScript and reports the result.
# Usage: tests/run.sh   (from anywhere; it runs from the repository root)
set -uo pipefail
cd "$(dirname "$0")/.."

output=$(osascript -l JavaScript tests/plugin.test.js 2>&1)
passed=$(grep -c '^ok' <<< "$output")
failed=$(grep -c '^FAIL' <<< "$output")

grep -v '^ok' <<< "$output" | grep -v '^async tests finished$' | grep -v '^$'
if ! grep -q '^async tests finished$' <<< "$output"; then
  echo "FAIL the asynchronous tests didn't finish"
  failed=$((failed + 1))
fi
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
