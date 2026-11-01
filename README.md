# Runnable Blocks

An Obsidian plugin that turns fenced code blocks into notebook cells. A `run` block gets a ▶ button, and its output streams in underneath. A `file` block writes its content to a file that later blocks can use. Both can check their result (exact text or MD5) and show a green or red border, which suits exercises and self-checking runbooks.

Desktop only, because it runs local processes.

## Writing blocks

Each block starts with a YAML header with its settings. A `---` line ends the header, and the code or file content goes below it. The header is hidden when the block is rendered.

````markdown
```run
lang: bash
editable: true
expect:
  md5: 8977ecbb8cb82d77fb091c7a7f186163
---
# your command here
```
````

The header can also open with its own `---`, like note frontmatter. Only the first `---` after the header ends it, so file content can contain `---` lines.

### `run` blocks

| Key | Meaning |
|---|---|
| `lang` | Interpreter to use (`bash`, `python`, `js`, …). Defaults to the default language in settings. |
| `editable` | `true` turns the code into an editor (see below). |
| `timeout` | Seconds before the block is killed. Overrides the global timeout. |
| `manual` | `true` leaves the block out of **Run all**, e.g. a teardown step. Works on file blocks too. |
| `idempotent` | `false` for a block that would fail, or do harm, if run a second time. It then runs once, until it's reset (see [Idempotency](#idempotency)). Defaults to `true`. |
| `depends-on` | The id of a block above, or a list of ids, that must have run successfully first (see [Prerequisites](#prerequisites)). |
| `requires` | What has to be true before the block can run: blocks that have run, commands that succeed, patterns the code matches (see [Prerequisites](#prerequisites)). |
| `revert` | A command that undoes what the block did: a string, or `lang` and `run`. **Reset** runs it (see [Reset and revert](#reset-and-revert)). |
| `expect.output` | Exact expected stdout. |
| `expect.md5` | Expected MD5 of stdout. |
| `expect.command-md5` | Expected MD5 of the code that ran. |
| `id` | Required: the block's UUID. Added the first time the block runs if it's missing (see [Block ids](#block-ids)). |
| `result` | The block's last result, written by the plugin (see [Saved results](#saved-results)). You don't write it yourself. |

`expect: <text>` on its own is shorthand for `expect.output`.

### `file` blocks

````markdown
```file
path: demo/app.yaml
editable: true
check:
  lang: bash
  run: awk '/replicas:/ {print $2}' "$FILE"
  expect:
    output: "3"
---
service:
  replicas: 1
```
````

| Key | Meaning |
|---|---|
| `path` | Where to write the file, relative to the working directory. Parent folders are created as needed. |
| `lang` | Syntax highlighting. Defaults to the file extension. |
| `editable` | `true` lets the learner edit the file, which is then kept in sync with the file on disk (see below). |
| `learner` | The learner's current version of the file. Written by the plugin; you don't need to set it. |
| `timeout`, `id`, `depends-on`, `requires`, `revert`, `idempotent` | As for `run` blocks. A file block's revert gets `$FILE`, as its check does. |
| `expect.content` | Exact expected file content. |
| `expect.md5` | Expected MD5 of the file content. |
| `check.run` | Command to run after writing. `$FILE` holds the file's absolute path. |
| `check.lang` | Interpreter for `check.run`. Defaults to the default language. |
| `check.expect.output` | Exact expected output of the check command. |
| `check.expect.md5` | Expected MD5 of the check command's output. |

A check runs a command, just as a `run` block does, so `check.expect` has the same shape as a `run` block's `expect`. The top-level `expect` describes the file itself.

Shorthands: `expect: <text>` means `expect.content`, `check: <command>` means `check.run`, and `check.expect: <text>` means `check.expect.output`. A `check` with no `expect` passes when the command exits with 0, which is handy for validators (`python -m json.tool "$FILE"`, a YAML parser, a linter). Multi-line commands use YAML's `|`.

Unknown keys inside `expect` or `check` show a warning on the block. The old `check.md5` points you to `check.expect.md5`.

**Editable file blocks stay in sync with their file:**
- The content below `---` stays the author's original. The learner's version is stored in the header as `learner:`, so it survives restarts.
- Typing writes the file and runs its checks about half a second after the learner stops. The note is updated when the editor loses focus, because updating it redraws the block.
- If the file changes on disk some other way (a `run` block's `sed -i`, another editor), the block shows the new content and stores it in the note.
- Opening a note creates a missing file, unless Reset deleted it this session. If the file on disk differs from the block, the disk version is taken as the learner's latest. The file is then checked as it is, so wrong files show red straight away. That runs the block's `check` command; turn off **Check when a note opens** if you'd rather it only ran after an edit.
- **Reset** goes back to the original, removes `learner:` and rewrites the file.

**Writing:**
- A non-editable file block has a write button that writes the file and runs its checks. Editable blocks don't need one; Shift+Enter in their editor writes and checks right away instead of waiting.
- Running a `run` block first writes every file block **above** it that changed since it was last written. Edits get picked up, and files that earlier commands modified aren't reset each time.
- **Run all** writes every file block.

Under the block, a note says whether the file on disk matches it, with a ✓ or ✗ for each check. What the check command prints is used only for validation and never shown.

Files can't be written into the vault's `.obsidian` folder. Writing outside the vault is off unless you allow it in settings.

### Results

**Statuses:** once a block has run, its border shows how it went:

- **Green:** `Pass`, when every check matched, or `Done` / `Written`, when it ran fine and has no checks.
- **Red:** `Fail`, when a check didn't match.
- **Orange:** `Exit N`, `Error`, `Timed out` or `Stopped`, when it didn't run cleanly.
- **Yellow, pulsing:** `Running…`, while a block runs, or `Checking…`, while a file block's check runs. If your system is set to reduce motion, the bar stays solid yellow.

A block that hasn't run yet has no colour. Every check is listed with ✓ or ✗ under the block, and a shield icon marks blocks that have checks.

**Hashes:** before hashing or comparing, text is normalized: `\r\n` becomes `\n`, and trailing whitespace and newlines are trimmed. So `echo hello` matches `expect.output: hello`, and its MD5 is that of `hello`:

```sh
printf %s 'hello' | md5      # macOS
printf %s 'hello' | md5sum   # Linux
```

You rarely need to compute hashes by hand. Run the block (or write the file), then switch to source mode: its `result:` has every hash, ready to copy into the header.

| To check… | Copy | Into |
|---|---|---|
| a `run` block's output | `result.output-md5` | `expect.md5` |
| the exact command | `result.command-md5` | `expect.command-md5` |
| a file block's content | `result.content-md5` | `expect.md5` |
| a file block's check output | `result.check.output-md5` | `check.expect.md5` |

YAML reads unquoted values like `0.10` or `1e3` as numbers. Quote expected values that must stay exactly as written (`output: "0.10"`). Also quote commands that contain `: ` or ` #`, or put them in a `|` block. If a header isn't valid YAML, or uses a setting the plugin doesn't know, the block shows a warning.

Readers can see the header, including `expect` answers, in source mode. Use the MD5 forms if the answer shouldn't be visible.

### Editable blocks

With `editable: true`, the block shows a text editor instead of highlighted code:

- **Shift+Enter** or **Cmd/Ctrl+Enter** runs the block (or writes the file). **Tab** indents.
- Edits stay in memory until Obsidian restarts. The note file isn't changed.
- Once you edit a block, an *edited* marker appears with **Reset** (back to the note's version) and **Save** (writes your edits into the note, keeping the header). Editable *file* blocks save themselves instead (see above).
- "Run all" uses the edited code too.

### Block ids

Every block needs an `id:` in its header: a UUID, unique within its note.

```yaml
id: 3f2b8c1e-9d4a-4c7e-8b1f-2a6d5e9c0b47
```

Edits, output and results belong to that id, so:
- **Identical blocks stay separate,** like two exercises that both start as `# your command here`.
- **A block keeps its output** when its code or header changes.

**If a block hasn't got one,** it gets one the first time it runs, and anything it had before (a draft, output) moves to the new id. That covers ▶, the write button, Shift+Enter, Run all, Save and pinning a hash. A synced file block gets its id when you leave its editor, in the same note edit that saves your work. Nothing is written to a note just because a block is displayed.

**An id that isn't a UUID,** such as an old short id, or a duplicate, such as a pasted copy of a block, counts as missing. The block shows a warning, and gets a new UUID the first time it runs. The first of two blocks with the same id keeps it.

To generate a UUID yourself, use `uuidgen | tr A-Z a-z` on macOS or Linux.

### Prerequisites

A block can have prerequisites: things that have to be true before it can run. There are three kinds:

| Kind | Met when | Typical use |
|---|---|---|
| `block` | That block, above in the same note, has run successfully. | Deploy before you configure. |
| `command` | The command exits 0. | A tool is installed, a file exists, a cluster is up. |
| `matches` | The block's own code matches the regular expression. | An exercise where the learner writes the command. |

List them in `requires:`, in the order you want them reported. Each entry can have a `message`, which is shown to the learner instead of the default description:

```yaml
requires:
  - block: 3d7bd56a-63be-49af-97e8-49bd9794886a
    message: Deploy the cluster first
  - command: command -v kubectl
    message: Install kubectl
  - matches: '^\s*kubectl\s+scale\b'
    flags: m
    message: Use kubectl scale
```

- **block**: the block's id. A bare id, `- 3d7bd56a-…`, is short for `- block: 3d7bd56a-…`.
- **command**: run with the default language, in the same folder and with the same `PATH` as the note's blocks. Set `lang` to use another interpreter, and `timeout` for longer than 10 seconds.
- **matches**: a JavaScript regular expression, tested against the block's code as the learner types it, or against the learner's version of an editable file block. `flags` are the usual ones: `m` makes `^` and `$` match at each line, `i` ignores case. Quote the pattern in YAML, with single quotes so backslashes stay as they are. Without a `message`, the learner just sees "The code isn't in the expected form yet", so the pattern doesn't give the answer away.

`depends-on` is shorthand for block entries, and can be used alongside `requires`:

```yaml
depends-on: 3d7bd56a-63be-49af-97e8-49bd9794886a
```

```yaml
depends-on:
  - 3d7bd56a-63be-49af-97e8-49bd9794886a
  - 99579044-9bb4-4e1c-93fc-1604cef37e39
```

**When a block is blocked:** until every prerequisite is met, the block is *blocked*. A block prerequisite counts as met once that block has run successfully (a green marker: it passed its checks, or ran cleanly if it has none), including results saved in the note from an earlier session (see [Saved results](#saved-results)). While blocked:
- It has a grey **Blocked** label and a dashed border, and its ▶ (or write) button is disabled.
- A **Before this can run** line lists each unmet prerequisite: a block's line in the note and why it doesn't count yet (not run yet, running, failed its checks, exit 1, …), a command and how it failed, or a pattern's message. The line updates as blocks finish and as the learner types.
- ▶, Shift+Enter and the write button refuse to run it, with a notice saying what's needed.
- **Run all** stops at a blocked block, for example one depending on a `manual` block, and says why.

If a prerequisite stops being met after the block ran, the block keeps its own result, but it's blocked again until it's met.

**When commands are checked:** when the note opens, and again each time the block runs, including in Run all, since what was installed or running earlier may not be now. Blocks with the same command share one check. If a command fails, fix the problem and press **Check again** on the Before this can run line. With **Check when a note opens** turned off in settings, commands only run when you press ▶, so nothing runs just because a note was opened.

**Getting an id:** switch to source mode and copy the block's `id:` line. A block gets its id the first time it runs, so run it once first if it hasn't got one.

**Problems that show:** a block id that isn't a UUID, an entry with none or more than one of `block`, `command` and `matches`, an unknown key in an entry, and a pattern that isn't a valid regular expression each get a warning; a bad pattern is ignored. An id that isn't in the note, or a block below the dependent one, shows in the Before this can run line.

### Saved results

When a block you ran finishes, its result is saved in its header as `result:`, which the rendered view hides. It's there after a restart, and it counts for `depends-on`.

```yaml
result:
  ran: "2026-11-01T10:00:00.000Z"
  duration-ms: 42
  exit: 0
  output-md5: 5d41402abc4b2a76b9719d911017c592
  command-md5: …
  stdout: hello
```

**What's saved:**
- **`run` blocks:** when the block ran, how long it took, the exit code, any error, timeout or stop, the MD5 of its output and of the code that ran, and its stdout and stderr.
- **Long output** is cut to 10,000 characters per stream, and marked `truncated`. Checks still evaluate, because exact-output checks compare hashes when the text has been cut.
- **`file` blocks:** the content's MD5, and the check's exit code and output MD5. Check output is never shown, so it isn't saved either.

**When it's saved:**
- when a block you ran finishes: ▶, the write button, Shift+Enter or Run all
- for an editable file block, when you leave its editor, together with your edits
- not for checks that run automatically when a note opens, so opening a note still doesn't change it

**Clearing:** **Clear output** (the eraser) removes a block's result from the note, and **Clear all outputs** does it for every block in the note.

**Things to know:**
- A saved result describes the run that produced it, not the present. After tearing a lab down, for example, a saved green marker for "deploy the cluster" still unblocks the blocks that depend on it. Clear the results, or run the blocks again.
- The note changes every time a block finishes. That makes noisy diffs, and can conflict with Obsidian Sync or git if you're editing the same note elsewhere.
- Output can contain secrets that commands print, such as tokens or passwords. Those end up in the note, and go wherever it's synced or committed.

### Idempotency

A block is *idempotent* if running it again is harmless, like `mkdir -p`. Blocks are assumed to be, unless they say otherwise. Mark one that isn't, such as `mkdir`, creating a resource, or appending to a file, with `idempotent: false`:

```yaml
idempotent: false
```

**Before it runs,** the block shows a "runs once" icon (↻1) in its toolbar.

**Once it has a result,** from this session or saved in the note:
- ▶ is disabled, and a line under the toolbar says why.
- ▶ and Shift+Enter refuse, with a notice.
- To run it again, **Reset** it. If it has a `revert:`, Reset undoes what it did first. Without one, Reset only clears the result, so the block can run again; whether that's safe is up to you.

**Run all** skips a run-once block that has already succeeded, and keeps its result, so running a whole page twice carries on past it. If its result was a failure, Run all stops there and asks you to reset it.

A run-once file block that has been written isn't rewritten automatically before the `run` blocks below it.

### Reset and revert

Every block has a **Reset** button. What it does depends on whether the block says how to undo itself, with `revert:`:

```yaml
revert: rm -rf demo/scratch
```

```yaml
revert:
  lang: python
  run: |
    import shutil
    shutil.rmtree("demo/scratch", ignore_errors=True)
```

**With a `revert:` (the button shows ↶),** Reset runs the revert command, with a pulsing yellow **Reverting…** bar:
- **If it works,** the block's result is removed, on screen and from the note. The block is back to not having run, and it shows **Reverted** with the revert's output, so you can see what was undone. Blocks that depend on it are blocked again. Press Reset once more to clear that record.
- **If it fails,** the block keeps its result, and the revert's output shows underneath in orange, with what went wrong.

**Without a `revert:` (the button shows the eraser),** Reset clears the block's result, on screen and from the note.

**File blocks** also have their file deleted, after the revert (if any) and clearing the result, so the lab is back to before the block was written. Editable file blocks also lose the learner's edits: the block goes back to the author's original. To be safe, the file is only deleted while it's still the one the block wrote; if something else has changed it since, it's kept and a notice says so. A deleted file stays deleted until the block writes it again: when the learner edits it, when you press write or **Restore the original code**, or when a run block below runs and needs it. Reset is available on a file block whenever its file is on disk or the learner has edited it, even with no result.

**Undo order:** Reset is unavailable while a block that depends on this one still has a result. Reset the dependent first, as with undo. It's also unavailable while the block is running, or when there's nothing to reset. The button's tooltip says which.

**Reset all blocks in current note:** in the command palette. It resets the whole note from the bottom up, which reverts blocks in the right order. With `revert:` on its blocks, a setup page can tear its lab down this way.

The **Restore the original code** button (↺), on editable blocks, is separate: it undoes your edits to the code, not what the block did. On a file block it writes the original back and checks it, rather than deleting the file, and doesn't run the revert.

### Writing an exercise

1. Write the correct solution in the block and run it.
2. In source mode, copy the output MD5 from its `result:` into `expect.md5`, or `check.expect.md5` for a check. Copy the command MD5 into `expect.command-md5` too, if the exact command matters.
3. Replace the solution with a placeholder and set `editable: true`. The learner types an answer into the block, runs it, and sees Pass or Fail.

## Commands

- **Run all blocks in current note**: runs every block in order, skipping `manual: true` blocks. Like a notebook, it stops at the first block that fails or errors, since later blocks usually depend on it.
- **Reset all blocks in current note**: resets every block that has run, from the bottom of the note up, so a block is reverted before the blocks it depends on. Stops at the first block that can't be reset.
- **Clear all outputs in current note**: clears every block's result, on screen and in the note, without reverting anything. Use it with care on blocks that have a `revert:`: their effects stay, but the note no longer says they ran.

## Settings

- **Interpreters**: one `lang = command` per line. `{file}` is replaced with a temp file holding the code. Built in: `bash`, `sh`, `zsh`, `python`/`py`, `js`/`javascript`/`node`, `ruby` and `go`.
  - **Go** blocks must be complete programs, with `package main` and `func main()`. They're compiled and then run, rather than run with `go run`, so the block gets the program's own exit code. (`go run` exits with 1 whenever the program fails.) The first run compiles the standard library and can take a few seconds; later runs use Go's build cache.
- **Default language**: used when a block has no `lang`.
- **Extra PATH entries**: Obsidian doesn't load your shell profile. `/opt/homebrew/bin` and `/usr/local/bin` are added by default.
- **Working directory**: the note's folder (default) or the vault root.
- **Timeout**: 30 s by default.
- **Check when a note opens**: on by default. Runs editable file blocks' check commands, and command prerequisites, without a click.
- **Allow file blocks to write outside the vault**: off by default.

Scripts also get the `OBSIDIAN_VAULT` and `OBSIDIAN_NOTE` environment variables (absolute paths).

## Install for development

```sh
ln -s "$PWD" "/path/to/vault/.obsidian/plugins/runnable-blocks"
```

Then enable **Runnable Blocks** under Settings → Community plugins, and open `example.md` (copy it into the vault) to try it out. The plugin is plain JavaScript with no build step. Edit `main.js` and reload the plugin.

## Tests

```sh
tests/run.sh
```

This runs `tests/plugin.test.js` with macOS's built-in JavaScript (`osascript -l JavaScript`), so it needs no Node or npm. Small stand-ins replace Obsidian's API, Node's `crypto`, `fs` and `path`, and YAML. The tests cover parsing blocks and headers, editing headers, evaluating checks, block ids and file-block syncing, partly against `example.md`. They don't cover rendering in Obsidian. The script prints any failures and a summary, and exits non-zero if anything failed.

## Security

`run` blocks only run when you click ▶ or use **Run all**. Editable file blocks run their `check` commands as you edit them, and when their note opens (unless you turn that setting off). Everything runs with your full user permissions, so read notes from other people before opening them with this plugin on.
