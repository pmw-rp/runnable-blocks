#!/bin/bash
# Installs Runnable Blocks into an Obsidian vault, from this checkout.
#
#   ./install.sh VAULT              copy the plugin's files into the vault
#   ./install.sh --link VAULT       link the vault's plugin folder to this checkout instead, for
#                                   development: edits here take effect when the plugin is reloaded
#   ./install.sh --tutorial VAULT   also copy the tutorial into the vault, as Runnable Blocks Tutorial/
#
# Then, in Obsidian: Settings → Community plugins, turn on community plugins if asked, and enable
# Runnable Blocks. If it was already enabled, turn it off and on again to load the new version.
set -euo pipefail
cd "$(dirname "$0")"

link=0 tutorial=0 vault=
for arg in "$@"; do
  case "$arg" in
    --link) link=1 ;;
    --tutorial) tutorial=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) vault=$arg ;;
  esac
done
[ -n "$vault" ] || { echo "Usage: ./install.sh [--link] [--tutorial] VAULT" >&2; exit 2; }
vault=${vault%/}
[ -d "$vault/.obsidian" ] || { echo "$vault isn't an Obsidian vault: it has no .obsidian folder. Open it in Obsidian once first." >&2; exit 1; }

id=$(python3 -c 'import json; print(json.load(open("manifest.json"))["id"])' 2>/dev/null || echo runnable-blocks)
target="$vault/.obsidian/plugins/$id"
mkdir -p "$vault/.obsidian/plugins"

if [ "$link" = 1 ]; then
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "$target is a folder, not a link. Move it aside first (it may hold your settings, in data.json)." >&2; exit 1
  fi
  ln -sfn "$PWD" "$target"
  echo "Linked $target to $PWD"
else
  if [ -L "$target" ]; then
    echo "$target is a link to $(readlink "$target"). Remove it first to install a copy." >&2; exit 1
  fi
  mkdir -p "$target"
  # data.json, the plugin's settings in that vault, is left as it is.
  cp main.js manifest.json styles.css "$target/"
  echo "Installed Runnable Blocks $(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])' 2>/dev/null) into $target"
fi

if [ "$tutorial" = 1 ]; then
  dest="$vault/Runnable Blocks Tutorial"
  if [ -e "$dest/Tutorial.md" ]; then
    echo "$dest/Tutorial.md is already there, so it's left alone."
  else
    mkdir -p "$dest"
    cp tutorial/Tutorial.md "$dest/"
    echo "Copied the tutorial to $dest/Tutorial.md"
  fi
fi

echo
echo "Now, in Obsidian: Settings → Community plugins → enable Runnable Blocks."
