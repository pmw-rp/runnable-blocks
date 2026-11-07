---
tags:
  - runnable-blocks
  - tutorial
---
# Runnable Blocks tutorial

This note shows everything the Runnable Blocks plugin can do, with a working example of each. Run the blocks as you read, with ▶ on each one, or run the whole note with **Runnable Blocks: Run all blocks in current note** from the command palette. Everything the note creates goes in a `lab/` folder next to it, and [[#When you're finished]] removes it again.

To see how a block is written, switch to source mode (⌘E, or the book icon at the top right). Each block is a fenced code block whose language is `run` or `file`, with a short YAML header, then `---`, then the code. The plugin hides the header when it draws the block.

> [!info] What you need
> - **bash**, **python3** and **node**, for the language examples. macOS has bash; `brew install python node` adds the others.
> - For [[#12. Packages]] only: an internet connection, and **go** (`brew install go`) for its Go example.
>
> Blocks marked *Run all skips this* are left for you to run with ▶, because they fail on purpose, wait for you, or need something extra.

## 1. Run blocks

A `run` block runs its code and shows the output underneath. Press ▶:

```run
id: db0b25af-3afb-412c-bab2-93876e4e23fb
lang: bash
---
echo "Hello from $(basename "$SHELL")"
date +%Y
```

Its border turns green, and its status says **Done**: it ran, and exited with 0. The output stays in the note, so it's still there after a restart (see [[#9. Saved results]]).

Blocks can be in other languages. `lang` picks the interpreter; without it, a block uses the default language from the plugin's settings, which is `bash`.

```run
id: 1360d6e0-f25a-4986-85bc-a52c644deab8
lang: python
---
import sys
squares = [n * n for n in range(1, 6)]
print("Python", sys.version_info.major, "squares:", squares)
```

```run
id: 1075edec-83ca-4430-bf81-2a43337a222c
lang: js
---
const words = ["notebook", "cells", "in", "Obsidian"];
console.log(words.map((w) => w.toUpperCase()).join(" "));
```

Ruby (`lang: ruby`) and Go (`lang: go`) work the same way. **Settings → Interpreters** says which command runs each language, and you can add your own.

**Output streams in as it's printed.** This one takes three seconds:

```run
id: 26545d3e-2d9d-490e-a6c1-533e3690aed2
lang: bash
---
for i in 1 2 3; do
  echo "step $i"
  sleep 1
done
```

**Standard error shows in red.** It's shown, but checks only look at standard output:

```run
id: 0a44be82-cc55-4f2e-a35c-dbcc1259fdce
lang: bash
---
echo "this goes to stdout"
echo "this goes to stderr" >&2
```

**Every block gets two environment variables:** `OBSIDIAN_VAULT`, the vault's folder, and `OBSIDIAN_NOTE`, the note's file. Blocks run in the note's own folder, so relative paths, such as `lab/`, are next to the note.

```run
id: 001c2c4f-9036-4247-8530-8785d6b4e5da
lang: bash
expect: Tutorial.md
---
basename "$OBSIDIAN_NOTE"
```

**When a block doesn't exit cleanly,** its border turns orange. These three are left for you to run (*Run all skips this*), since each one stops a Run all. The first exits with 3, the second runs into its 2-second `timeout:`, and the third runs until you press ■ to stop it.

```run
id: be1c53b1-dbd0-4bb1-937e-3c1a2a293079
lang: bash
manual: true
---
echo "about to fail"
exit 3
```

```run
id: 4ac1c53d-47f0-4de0-b1de-0be2f029f7d9
lang: bash
manual: true
timeout: 2
---
echo "sleeping for 10 seconds, with a 2 second timeout"
sleep 10
```

```run
id: 9f202664-6914-4948-aaea-6044267fd6f6
lang: bash
manual: true
timeout: 300
---
while true; do
  date +%T
  sleep 1
done
```

Without `timeout:`, a block gets the timeout from the settings, 30 seconds by default.

## 2. Checking the output

A block can say what output it expects. It then shows **Pass**, with a green border, or **Fail**, with a red one, and a shield icon in its toolbar marks it as checked.

`expect:` gives the exact text:

```run
id: 158e177c-7c38-4246-931e-2d21a237d7b5
lang: bash
expect: "4"
---
echo $((2 + 2))
```

Text is compared after trimming trailing spaces and newlines, so `echo` lines match without fuss. Quote values YAML would read as numbers, such as `"4"` or `"0.10"`.

To check without showing the answer to anyone who switches to source mode, give its MD5 instead, with `expect.md5`. This one expects `hello`:

```run
id: 85bb4f99-6e2e-494d-be3a-f272c00b336f
lang: bash
expect:
  md5: 5d41402abc4b2a76b9719d911017c592
---
echo hello
```

You rarely work out a hash by hand: run the block, switch to source mode, and copy `output-md5` from its `result:` into `expect.md5`.

`expect.command-md5` checks the code itself, for when the exact command matters. This block passes as written, and fails if you change a single character of its code:

```run
id: b3d09f09-9fe7-41ce-8360-e0131fe7ee09
lang: bash
expect:
  command-md5: 178da377b9d3843b1518d43cbd61ee9e
---
echo "the exact command"
```

A failing check shows red, and lists what didn't match. *Run all skips this*, since it fails on purpose:

```run
id: cb1bde37-0015-4159-8877-7e5ee7adb3c6
lang: bash
manual: true
expect: "5"
---
echo $((2 + 2))
```

## 3. File blocks

A `file` block writes its content to a file, for the blocks after it to use. Press its save button (or run any block below it, which writes it first):

```file
id: bdfe5cb6-2fb4-42de-8631-d74afc19e724
path: lab/config.yaml
---
service:
  name: greeter
  replicas: 3
```

```run
id: 6e466cec-eead-4ef1-864d-e4aef1c55e3d
lang: bash
depends-on: bdfe5cb6-2fb4-42de-8631-d74afc19e724
expect: "greeter has 3 replicas"
---
name=$(awk '/name:/ {print $2}' lab/config.yaml)
replicas=$(awk '/replicas:/ {print $2}' lab/config.yaml)
echo "$name has $replicas replicas"
```

Under a file block, a footer says whether the file on disk matches it. Click `lab/config.yaml` in the file explorer, and it opens in the plugin's code editor, with highlighting (see [[#13. Code files]]).

A file block can check itself, too:
- `expect:` checks the content.
- `check:` runs a command against the written file, which is in `$FILE`. With no `expect`, it passes when the command exits with 0, which makes a quick validator:

```file
id: 14334977-2e89-417b-99d7-94114d14d84d
path: lab/settings.json
check: python3 -m json.tool "$FILE" > /dev/null
---
{
  "greeting": "hello",
  "count": 2
}
```

A check can also compare the command's output, with `check.expect`:

```file
id: cfc034a6-53dc-452e-bead-95cecd0a0864
path: lab/limits.conf
check:
  run: grep -c '^limit' "$FILE"
  expect: "2"
---
limit cpu 2
limit memory 4g
# a comment
```

## 4. Editable blocks

With `editable: true`, a block is an editor: change the code, then run it with ▶ or Shift+Enter. Try changing the name:

```run
id: cabc877e-a3f4-4544-b22f-5b194df9d45b
lang: bash
editable: true
---
name="world"
echo "Hello, $name"
```

- An *edited* marker shows once you've changed it.
- Your version is saved in the note when you leave the editor, and when the block runs. It goes where the author's code was, and the author's version moves into the header, as `original:`, so it's never lost. Switch to source mode to see it.
- **Reset** (the eraser) puts the author's version back.

Editable file blocks work the same way. Saving one writes the file and runs its checks. If something else changes the file on disk, the block shows the new content.

## 5. Order and prerequisites

**`depends-on`** names blocks that must have run successfully first. Until they have, a block is *Blocked*: its border is dashed, its ▶ is disabled, and a **Before this can run** line says what's missing.

This block makes a folder, and the one after it depends on it. Reset the first, and the second is blocked again:

```run
id: 65cd8b1c-4d60-4396-8546-91ec000edf6c
lang: bash
revert: rm -rf lab/shelf
---
mkdir -p lab/shelf
echo "made lab/shelf"
```

```run
id: f6107106-709d-42b3-9df2-c9b24d5fc906
lang: bash
depends-on: 65cd8b1c-4d60-4396-8546-91ec000edf6c
expect: "1 book on the shelf"
---
touch lab/shelf/book.txt
echo "$(ls lab/shelf | wc -l | tr -d ' ') book on the shelf"
```

A block can depend on a block in another note too: ids are unique, so `depends-on` needs no note name. Courses use this for a lab page that needs its setup page.

**`requires`** lists other kinds of prerequisite, each with a message for the learner:
- `block`: a block, as `depends-on` does.
- `command`: a command that has to succeed, such as checking a tool is installed, or a lab is running.
- `matches`: a pattern the block's own code has to match (see [[#11. Writing an exercise]]).

```run
id: 4f6c1f3b-6291-4442-b72d-2ab5e66baa5c
lang: bash
requires:
  - command: command -v python3
    message: Install Python 3 (brew install python)
  - command: test -f lab/config.yaml
    message: Save lab/config.yaml in section 3 first
---
python3 -c "print('python3 is installed, and lab/config.yaml is there')"
```

Commands are checked when the note opens, if **Check when a note opens** is on in the settings, and each time the block runs. If one fails because of something you then fix outside Obsidian, press **Check again** on the Before this can run line.

## 6. Running once, and undoing

**`revert:`** says how to undo a block. Its **Reset** button then shows ↶, and runs the revert before clearing the result:

```run
id: ae48758d-5217-4498-8308-7a87e29c5b0d
lang: bash
revert: rm -rf lab/scratch && echo "removed lab/scratch"
---
mkdir -p lab/scratch
for n in 1 2 3; do echo "file $n" > "lab/scratch/file$n.txt"; done
ls lab/scratch
```

A revert can be in another language, with `lang` and `run`, as in [[#8. Alternative ways]].

**`idempotent: false`** marks a block that mustn't run twice, such as one that appends to a file or creates something that already exists. It shows ↻1, and once it has run, its ▶ is disabled until you reset it:

```run
id: d2d86da3-40e4-42c9-958a-e1d287049116
lang: bash
idempotent: false
revert: rm -f lab/visits.log
---
echo "visited at $(date +%T)" >> lab/visits.log
wc -l < lab/visits.log | tr -d ' '
```

**Undo order:** a block can't be reset while a block that depends on it still has a result, as with undo. Try resetting the "made lab/shelf" block in section 5 while the one after it is green. **Runnable Blocks: Reset all blocks in current note** resets every block from the bottom up, so reverts run in the right order.

**`manual: true`** leaves a block out of Run all, as with the blocks above that fail on purpose. Teardown steps are often manual, like the one in [[#When you're finished]].

## 7. Environment variables

`env:` sets environment variables for a block's code and its revert:

```run
id: 74f4b6e1-c062-4aec-99f5-e4d0315c4cef
lang: bash
env:
  GREETING: Bonjour
  TARGET: tout le monde
expect: "Bonjour, tout le monde"
---
echo "$GREETING, $TARGET"
```

## 8. Alternative ways

Sometimes there's more than one way to do a step, such as creating a cluster or using one you already have. The usual way is written as normal. Each alternative's first block says what it's `instead-of`, and the blocks that depend on it are the rest of that way. Only one way can be in use: once one has run, the others show *Not needed*.

A chooser picks a way up front, and hides the others' sections. Pick a way, and the others disappear. Run all then takes the way you picked; without a pick, it takes the usual one.

```choose
for: 156c3b41-e94c-4399-9fd3-9958aa095986
labels:
  156c3b41-e94c-4399-9fd3-9958aa095986: Shell
  7cf42487-2d89-46e5-8fb4-0948ed5ba7a1: Python
  a59bb877-d014-40a7-a0cb-608a646d3ce1: Your own
```

### Write the greeting with the shell

The usual way.

```run
id: 156c3b41-e94c-4399-9fd3-9958aa095986
lang: bash
revert: rm -f lab/greeting.txt
---
echo "hello from the shell" > lab/greeting.txt
echo "wrote lab/greeting.txt"
```

### Write the greeting with Python

Instead of the shell. Its revert is in Python too.

```run
id: 7cf42487-2d89-46e5-8fb4-0948ed5ba7a1
lang: python
instead-of: 156c3b41-e94c-4399-9fd3-9958aa095986
revert:
  lang: python
  run: |
    import os
    if os.path.exists("lab/greeting.txt"):
        os.remove("lab/greeting.txt")
---
with open("lab/greeting.txt", "w") as f:
    f.write("hello from Python\n")
print("wrote lab/greeting.txt")
```

### Write your own greeting

Instead of the shell: change the greeting, then run it.

```run
id: a59bb877-d014-40a7-a0cb-608a646d3ce1
lang: bash
editable: true
instead-of: 156c3b41-e94c-4399-9fd3-9958aa095986
revert: rm -f lab/greeting.txt
---
echo "hello from me" > lab/greeting.txt
echo "wrote lab/greeting.txt"
```

### Read the greeting

Every way needs this, so it depends on the usual way's block. When another way has run, that way stands in for it.

```run
id: 70e8eed8-59ca-407e-919e-bb38816de83f
lang: bash
depends-on: 156c3b41-e94c-4399-9fd3-9958aa095986
---
cat lab/greeting.txt
```

## 9. Saved results

When a block finishes, its result is saved in its header, as `result:`: when it ran, how long it took, its exit code, the MD5s of its output and code, and the output itself. Switch to source mode to see one. That's how output survives a restart, and how a block in another session, or another note, knows its prerequisites have run.

- **Clear output** (the eraser, on a block without a revert) removes its result from the note.
- **Runnable Blocks: Clear all outputs in current note** does it for every block, without reverting anything.

A saved result describes the run that made it, not the present. If you delete `lab/` by hand, the blocks above stay green until you run or reset them.

> [!tip] Keeping results out of git
> Results and learners' answers belong to whoever ran the note, not to the course. A course vault can strip them on commit with a git clean filter: the Learning Path vault's `.gitfilters/strip-progress.py` is one.

## 10. Blocks in callouts

Blocks work inside callouts, which is handy for optional extras:

> [!example]- An extra, folded away
> Open this callout, then run the block inside it.
>
> ```run
> id: 9ae84f99-0579-4ffa-9eec-2e317206ed32
> lang: bash
> expect: "inside a callout"
> ---
> echo "inside a callout"
> ```

## 11. Writing an exercise

An exercise is an editable block with a placeholder, and a check block after it that tests what the learner did, not what they typed, so any correct answer passes.

**Your turn:** write a command that creates `lab/answer.txt` containing the word `forty-two`. *Run all skips this*: it's yours to do.

```run
id: 9c035657-5b6a-41d0-97ed-4c9056f88422
lang: bash
editable: true
manual: true
requires:
  - matches: '^(?![\s\S]*(?:^|\n)[ \t]*rm\b)'
    message: "Don't delete anything: there's no rm in the answer"
revert: rm -f lab/answer.txt
---
# your command here
```

The `matches` rule above guards against a harmful answer: type `rm` at the start of a line, and the block is blocked, with that message. Exercises use it only for mistakes that would do harm. Exploring, such as running `ls` or `--help`, is always allowed.

**Done when** the file has the right word in it:

```run
id: 6b47c782-d7ce-41d7-a5ad-ce17aa0d4412
lang: bash
manual: true
depends-on: 9c035657-5b6a-41d0-97ed-4c9056f88422
expect: "lab/answer.txt says forty-two"
---
if grep -qx 'forty-two' lab/answer.txt 2>/dev/null; then
  echo "lab/answer.txt says forty-two"
else
  echo "lab/answer.txt doesn't say forty-two yet"
fi
```

To write one yourself: write the correct answer in the block, run it, copy the MD5s you need from its `result:`, then replace the answer with a placeholder and set `editable: true`.

An editable file block makes an exercise of a config file. This one wants the replicas raised to 3, and checks only that, so the rest of the file can be anything. Edit it, then press save:

```file
id: 64a49e89-c6a3-41ea-b9f1-2eca51129844
path: lab/deployment.yaml
editable: true
manual: true
check:
  run: awk '/replicas:/ {print $2}' "$FILE"
  expect: "3"
---
app: greeter
replicas: 1
```

## 12. Packages

A `python`, `js` or `go` block can list the libraries it imports, in `packages:`. The first run installs them, into `lab/.packages` next to the note, which can take a minute; its progress shows in red. After that, every block with the same packages shares the install. *Run all skips these*, since they need the internet, and the last needs Go.

```run
id: 42e41eb9-82ec-4d32-a84b-771d8a2bee3d
lang: python
manual: true
packages:
  - python-dateutil==2.9.0.post0
---
from dateutil.relativedelta import relativedelta
from datetime import date
print("in 18 months:", date(2026, 1, 31) + relativedelta(months=18))
```

```run
id: 58577754-4031-4ed5-8521-97e5a1381916
lang: js
manual: true
packages:
  - lodash@4.17.21
---
const _ = require("lodash");
console.log(_.chunk(["a", "b", "c", "d", "e"], 2));
```

```run
id: d4fe04da-3492-440a-ac6a-8f76be4cd393
lang: go
manual: true
timeout: 120
packages:
  - github.com/google/uuid@v1.6.0
---
package main

import (
	"fmt"

	"github.com/google/uuid"
)

func main() {
	fmt.Println("a new UUID:", uuid.NewString())
}
```

Pin each package's version, as here, so the note keeps working when a library releases a new one.

## 13. Code files

Files that blocks write, such as `lab/config.yaml`, open in the plugin's own code editor when you click them in the file explorer, with syntax highlighting. Edits save as you type. If a block rewrites the file, the editor shows the new version. **Settings → Open these files in the code editor** lists the file types it opens.

Obsidian's file explorer hides file types it doesn't know. To see them all, turn on **Settings → Files and links → Detect all file extensions**.

## 14. Settings

Under **Settings → Runnable Blocks**:

| Setting | What it does |
|---|---|
| Interpreters | The command for each language, one `lang = command` per line. `{file}` is the code's temporary file. |
| Default language | For blocks without `lang`. |
| Extra PATH entries | Obsidian doesn't read your shell profile, so add the folders your tools are in. |
| Working directory | The note's folder (the default), or the vault's. |
| Timeout | For blocks without `timeout`: 30 seconds by default. |
| Check when a note opens | Runs file checks and command prerequisites as soon as a note opens. Off by default, so nothing runs until you press something. |
| Allow file blocks to write outside the vault | Off by default. |
| Open these files in the code editor | The file types for [[#13. Code files]]. |

## When you're finished

Run **Runnable Blocks: Reset all blocks in current note**. It works up from the bottom: each block with a revert undoes what it did, and every result is cleared. Then this removes whatever's left in `lab/`, including any installed packages. *Run all skips this.*

```run
id: a69f8d8d-0595-40e4-9d6b-18b0a5e237a4
lang: bash
manual: true
---
rm -rf lab
echo "removed lab/"
```
