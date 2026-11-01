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
| `depends-on` | The id of a block above, or a list of ids, that must have run successfully first (see [Dependencies](#dependencies)). |
| `expect.output` | Exact expected stdout. |
| `expect.md5` | Expected MD5 of stdout. |
| `expect.command-md5` | Expected MD5 of the code that ran. |
| `id` | Required: the block's UUID. Added the first time the block runs if it's missing (see [Block ids](#block-ids)). |

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
| `timeout`, `id`, `depends-on` | As for `run` blocks. |
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
- Opening a note creates a missing file. If the file on disk differs from the block, the disk version is taken as the learner's latest. The file is then checked as it is, so wrong files show red straight away. That runs the block's `check` command; turn off **Check editable file blocks when a note opens** if you'd rather it only ran after an edit.
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

A block that hasn't run yet has no colour. Every check is listed with ✓ or ✗ under the block, and a shield icon marks blocks that have checks.

**Hashes:** before hashing or comparing, text is normalized: `\r\n` becomes `\n`, and trailing whitespace and newlines are trimmed. So `echo hello` matches `expect.output: hello`, and its MD5 is that of `hello`:

```sh
printf %s 'hello' | md5      # macOS
printf %s 'hello' | md5sum   # Linux
```

You rarely need to compute hashes by hand. Run the block (or write the file), open the **#** menu, and choose a **Pin** item (`expect.md5`, `expect.command-md5` or `check.expect.md5`). It writes the hash into the header and leaves the rest of the header as you wrote it.

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
- **A block keeps its output** when its code changes or a hash is pinned.

**If a block hasn't got one,** it gets one the first time it runs, and anything it had before (a draft, output) moves to the new id. That covers ▶, the write button, Shift+Enter, Run all, Save and pinning a hash. A synced file block gets its id when you leave its editor, in the same note edit that saves your work. Nothing is written to a note just because a block is displayed.

**An id that isn't a UUID,** such as an old short id, or a duplicate, such as a pasted copy of a block, counts as missing. The block shows a warning, and gets a new UUID the first time it runs. The first of two blocks with the same id keeps it.

To generate a UUID yourself, use `uuidgen | tr A-Z a-z` on macOS or Linux.

### Dependencies

A block can depend on blocks above it in the same note. List their ids in `depends-on`, as one id or a list:

```yaml
depends-on: 3d7bd56a-63be-49af-97e8-49bd9794886a
```

```yaml
depends-on:
  - 3d7bd56a-63be-49af-97e8-49bd9794886a
  - 99579044-9bb4-4e1c-93fc-1604cef37e39
```

**When a block is blocked:** until every block it depends on has run successfully this session (a green marker: it passed its checks, or ran cleanly if it has none), the block is *blocked*:
- It has a grey **Blocked** label and a dashed border, and its ▶ (or write) button is disabled.
- A **Waiting for** line names each unfinished dependency, its line in the note, and why: not run yet, running, failed its checks, exit 1, and so on. The line updates as dependencies finish.
- ▶, Shift+Enter and the write button refuse to run it, with a notice saying what to run first.
- **Run all** stops at a blocked block, for example one depending on a `manual` block, and says why.

If a dependency fails after the block ran, the block keeps its own result, but it's blocked again until the dependency succeeds.

**Getting an id:** use **Copy block id** in a block's **#** menu. A block gets its id the first time it runs, so run it once before copying.

**Problems that show:** an id that isn't a UUID gets a warning. An id that isn't in the note, or a block below the dependent one, shows in the Waiting for line.

### Writing an exercise

1. Write the correct solution in the block and run it.
2. Pin the output MD5 (or check MD5). Pin the command MD5 too if the exact command matters.
3. Replace the solution with a placeholder and set `editable: true`. The learner types an answer into the block, runs it, and sees Pass or Fail.

## Commands

- **Run all blocks in current note**: runs every block in order, skipping `manual: true` blocks. Like a notebook, it stops at the first block that fails or errors, since later blocks usually depend on it.
- **Clear all outputs in current note**

## Settings

- **Interpreters**: one `lang = command` per line. `{file}` is replaced with a temp file holding the code. Built in: `bash`, `sh`, `zsh`, `python`/`py`, `js`/`javascript`/`node`, `ruby` and `go`.
  - **Go** blocks must be complete programs, with `package main` and `func main()`. They're compiled and then run, rather than run with `go run`, so the block gets the program's own exit code. (`go run` exits with 1 whenever the program fails.) The first run compiles the standard library and can take a few seconds; later runs use Go's build cache.
- **Default language**: used when a block has no `lang`.
- **Extra PATH entries**: Obsidian doesn't load your shell profile. `/opt/homebrew/bin` and `/usr/local/bin` are added by default.
- **Working directory**: the note's folder (default) or the vault root.
- **Timeout**: 30 s by default.
- **Check editable file blocks when a note opens**: on by default. Runs their check commands without a click.
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
