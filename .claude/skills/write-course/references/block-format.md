# Block format, for course authors

The full reference is the plugin's `README.md` at the repository root. This is the part a course needs, with the patterns that have worked.

## Shape

````markdown
```run
id: 3d7bd56a-63be-49af-97e8-49bd9794886a
lang: bash
depends-on: 13656d2f-665f-47b4-89db-c9ed209fd1d1
timeout: 300
expect:
  output: "source: True, shadow: True"
---
the code
```
````

- The fence is ` ```run ` or ` ```file `. The header is YAML, ended by a line `---`, and the code follows it.
- **Every block needs an `id:`**, a lowercase UUID, unique across the whole vault. Generate them with `uuidgen | tr A-Z a-z`, one per block. Never reuse or copy one: dependencies find blocks by id across notes.
- Blocks work inside callouts too. Prefix every line with `> `.
- `result:` and `learner:` entries are written by the plugin as the learner works. Don't write them, and remove any left over from testing.
- Quote YAML values containing `: ` or ` #`. Use single quotes for regular expressions, so backslashes stay as they are. Use `|` for multi-line values.

## Header keys

| Key | Blocks | Meaning |
|---|---|---|
| `id` | both | UUID (required) |
| `lang` | both | `bash` (default), `sh`, `zsh`, `python`, `js`, `ruby`, `go`. On a file block it only picks the highlighting, and defaults from the extension. |
| `path` | file | Where to write it, relative to the note's folder. Use `lab/…`. |
| `editable` | both | `true` lets the learner edit it. An editable file block stays in sync with the file on disk. |
| `timeout` | both | Seconds before it's killed (default 30). Raise it for anything slow. |
| `manual` | both | `true` leaves it out of Run all, for teardown blocks. |
| `idempotent` | both | `false`: it runs once, until it's reset. For anything that fails or does harm a second time. |
| `depends-on` | both | An id, or a list of ids, that must have passed first. Same note or any other. |
| `requires` | both | A list of prerequisites (below). |
| `revert` | both | Undoes the block: a command, or `lang` and `run`. Reset runs it. A file block's revert gets `$FILE`. |
| `expect` | both | Run: `output`, `md5`, `command-md5`. File: `content`, `md5`. |
| `check` | file | A command run against the written file (`$FILE`), with its own `expect: { output, md5 }`. It passes on exit 0 if it has no expect. |

## Checks

A check block prints one short, deterministic line and expects it:

```bash
ready() { kubectl get redpanda redpanda -n "$1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'; }
echo "source: $(ready source), shadow: $(ready shadow)"
```

- Summarise with `echo` and `$(…)`, not raw output: no ages, timestamps, pod hashes or column widths.
- Wrap command substitutions in quotes, `echo "$(f)"`, so multi-line values don't get joined. One check printed `redpanda-pool2redpanda-pool2redpanda-pool2` without this.
- Multi-line expected output uses `output: |-`.
- To hide the answer, use `expect.md5`: the MD5 of the output with trailing whitespace removed, e.g. `printf '%s' 'nginx:1.27' | md5`.
- `command-md5` also checks the code itself. It's rarely what you want for exercises, because any other correct answer fails.
- If a check reads something that arrives asynchronously, wait for it inside the block with a bounded loop first.

## Prerequisites (`requires:`)

```yaml
requires:
  - block: 3d7bd56a-63be-49af-97e8-49bd9794886a   # passed (a bare id is the same)
    message: Deploy the cluster first
  - command: command -v kubectl                   # exits 0; checked on open and before every run
    timeout: 20                                   # default 10 seconds
    message: Install kubectl
  - matches: '^\s*kubectl\s+scale\b'              # the block's own (learner's) code matches
    flags: m
    message: Use kubectl scale
```

- `depends-on` and `requires` can be used together. A block is blocked until all of them are met, and the learner sees each unmet one's `message`.
- `matches` patterns are JavaScript regular expressions, tested as the learner types. Without a `message`, the learner sees a generic "not in the expected form yet", which doesn't give the answer away.
- In multi-line (`m`) patterns, anchor on the command line (`^(?=\s*rpk\s)…`), or a comment line could satisfy them.
- A pattern that forbids something uses a negative lookahead: `(?!.*\s--profile(=|\s+)shadow)`.

## Reverts

```yaml
revert: |
  kind get clusters 2>/dev/null | grep -qx shadow-linking || { echo "The cluster is already gone, so there is nothing to undo"; exit 0; }
  kubectl --context kind-shadow-linking delete shadowlink shadow-link -n shadow --ignore-not-found --wait --timeout=120s
```

- Undo exactly what the block did, and nothing more.
- Reset runs a revert only if the block has run. It then clears the result, and for a file block deletes the file, if it's still the one the block wrote.
- A block can't be reset while a block that depends on it, in any note, has a result. So Reset all goes bottom up, and lessons are reset before their setup page.
- Name the cluster or context explicitly, guard on it existing, and tolerate things already being gone.
- If the block can't really be undone, leave out `revert`, set `idempotent: false`, and explain in the page.

## Gotchas found the hard way

- Blocks run in the note's folder, so `lab/` is per course.
- stderr shows in red. Say so where a tool writes progress there (kind, helm).
- Run all doesn't pause between blocks. Wait for nodes, rollouts, replication and port forwards explicitly.
- Background processes need `nohup`, a PID file, and a revert that kills them.
- Certificates need every name clients will use (service names, `localhost`), or an upgrade later fails TLS.
- `rpk cluster health` exits non-zero (10) while the cluster is unhealthy, not only when it's unreachable. Use `rpk cluster info` to test it's reachable, in prerequisites and in revert guards alike: a guard that tests health skips the undo whenever the cluster is briefly unhealthy. To wait for health, require several healthy readings in a row: just after a restart it flips back and forth.
- A long-running process the learner would leave in a second terminal, such as a consumer, becomes a background block (`nohup`, a PID file, and a revert that kills it) with exercises around it.
- A command that waits forever, such as a consumer without a count, times out in a block. Tell the learner to give it a stopping point, and gate it with a pattern if needed.
- Charts and images move. Pin versions, by digest where it matters, and check they're current when writing.
