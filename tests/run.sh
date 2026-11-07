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
# The tutorial is hard-linked into the Learning Path vault. Anything that replaces the file rather
# than writing into it (git checkout, git stash, some editors) breaks the link, silently.
vault_tutorial="/Users/pmw/Documents/LearningPath/Learning Path/Tutorial/Tutorial.md"
if [ -e "$vault_tutorial" ] && [ ! tutorial/Tutorial.md -ef "$vault_tutorial" ]; then
  echo "WARNING tutorial/Tutorial.md is no longer the same file as the vault's Tutorial/Tutorial.md. Relink it with:"
  echo "  ln -f tutorial/Tutorial.md \"$vault_tutorial\"   (after copying over whichever has the changes you want)"
fi
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
