#!/bin/bash
# Publishes a release on GitHub, for people to install from: the plugin's files, attached to a
# release tagged with manifest.json's version. BRAT and manual installs both use these.
#
#   ./release.sh            release the version in manifest.json
#
# Before running it: bump "version" in manifest.json, add it to versions.json (version → the oldest
# Obsidian it works with), commit, and push. Needs the GitHub CLI (gh), logged in.
set -euo pipefail
cd "$(dirname "$0")"

version=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
python3 -c "import json, sys; v = json.load(open('versions.json')); sys.exit(0 if '$version' in v else 1)" \
  || { echo "versions.json has no entry for $version. Add one, then commit." >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "There are uncommitted changes. Commit them first." >&2; exit 1; }
git fetch --quiet origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] || { echo "This branch isn't the same as its upstream. Push (or pull) first." >&2; exit 1; }
if gh release view "$version" > /dev/null 2>&1; then
  echo "There's already a release $version. Bump the version in manifest.json first." >&2; exit 1
fi

tests/run.sh

# The tag is the version itself, with no "v": that's what Obsidian and BRAT look for.
gh release create "$version" main.js manifest.json styles.css \
  --title "$version" --notes "Runnable Blocks $version. To install, see the README."
echo "Released $version"
