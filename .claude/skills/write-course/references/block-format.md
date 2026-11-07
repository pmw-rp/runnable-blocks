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
- `result:`, `original:` and `learner:` entries are written by the plugin as the learner works. Don't write them, and remove any left over from testing. When a learner edits an editable block, their answer goes below `---` and the author's code moves into `original:`, so in a block with `original:`, the code below `---` isn't the course's.
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
| `instead-of` | both | Ids of blocks this one is an alternative to: it starts an alternative path (below). |
| `packages` | run | In a `python`, `js` or `go` block: the libraries its code imports, pinned (`name==1.2.3`, `name@1.2.3`, `module@v1.2.3`). Installed the first time it runs (below). |
| `env` | run | Environment variables for the code and its revert, as a map. |
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

### Gating one command, and allowing the rest

Let the learner run anything else in the box, such as `docker ps`, `--help` or `rpk … describe`, and run it on its own first, before writing the task's command at all. Never require a line to be there: a rule like "the box must contain `rpk topic consume orders`" blocks the box until the whole answer is written, so the learner can't explore, or build it a line at a time. And only gate a command that would do harm, or whose shape a revert or a later step relies on (a revert that deletes `orders` needs the topic to be called `orders`). Otherwise leave the box open, with no `matches:` at all, and let the check after it say whether it worked. Restrict only the task's command: at most once, on a line of its own, and right. Every rule is written as "no line with the command breaks this", so a box without the command passes, and the learner can explore.

With `T` as a pattern for the start of the command's line (`docker\s+kill\b`, `rpk\b.*\bsecurity\s+acl\s+create\b`), followed by `(?![^\n]*\s(?:-h|--help)(?:\s|$))` so a `--help` line doesn't count, and `L` for a line start, `(?:^|\n)[ \t]*`, none of them needing flags:

| Rule | Pattern |
|---|---|
| At most once | `^(?![\s\S]*L T[\s\S]*L T)` |
| On a line of its own | ``^(?![\s\S]*L T[^\n]*[;&\|<>$`\\(){}])`` |
| The line has something, e.g. `-n 3` | `^(?![\s\S]*L T(?!.*\s(?:-n\|--nodes)(?:=\|\s+)?3(?:\s\|$)))` |
| The line is exactly a shape, e.g. `docker kill rp-node-N` | `^(?![\s\S]*(?:^\|\n)(?![ \t]*docker\s+kill\s+rp-node-\d+[ \t]*(?:\n\|$))[ \t]*T)` |

(The `\|` in the table are plain `|` in the note.) Since the box can now run more than once, drop `idempotent: false` and guard anything dangerous to repeat with a `command:` prerequisite instead, for example "all three brokers are running" before a kill. Generate the patterns from one template rather than writing them by hand, quote every `message` in YAML (a message with `: ` in it isn't valid YAML otherwise), and test each with `scripts/check.js … --patterns`, including a box with only exploring commands in it.

## Alternative paths (`instead-of:`)

For a choice of ways at the start of a course, such as creating a kind cluster or using the learner's own, write the usual way, then the alternative, and put `instead-of:` (the ids of the usual way's blocks it replaces) on the alternative's first block. The blocks that depend on it, directly or through each other, are the rest of its path. Steps both ways need depend on the usual way's blocks, never the alternative's, so they stay off the path.

- Run all takes the usual way. The learner chooses the alternative by running (or saving) its first block; then the replaced blocks show *Not needed*, Run all follows the alternative, and once the whole path has passed, the replaced blocks count as done for their dependents.
- Only one way can be in use: the other shows *Not needed* until it's reset. Several alternatives can replace the same blocks (k3sd, EKS, your own, instead of kind); they exclude each other as well. `Kubernetes cluster/Kubernetes cluster.md` is the model.
- With three or more ways, add a chooser: a `choose` block with `for:` (the usual way's first block) and `labels:` (block id: button text). The learner picks a way, and the other ways' sections are hidden, so put each way under a heading of its own (`### 2b. Or …`), and what every way needs under a heading after them. Run all takes the way picked. See "Choosing a way" in the README.
- A lesson step that only one way needs, such as a port forward to the learner's own cluster where kind maps the port itself, `depends-on` that way's last block. It's then on that path: Run all skips it on the other way. Only the path's blocks in the setup note have to pass for it to stand in, so a later lesson's step doesn't hold up setup.
- Make both ways end in the same state, so everything after works on either. For Kubernetes, that means one context name every later block uses (`--context NAME`): the kind way names its context with `kubectl config set-context NAME --cluster kind-X --user kind-X`, and the own-cluster way points the same name at the learner's context. Their reverts delete that context, and reverts guard with `kubectl config get-contexts NAME`, not `kind get clusters`.
- On a learner's own cluster, check before changing anything: reachable, admin rights (`kubectl auth can-i create customresourcedefinitions`), a default StorageClass, and none of the namespaces the lab creates, since Reset would delete them. Something cluster-wide that's already there, such as an operator, is better used as it is, recording that it was there (`lab/NAME.preexisting`) so Reset leaves it alone. The shared `Kubernetes cluster` page's add-ons are the model.
- Test both: `scripts/run.js NOTE` takes the usual way, and `--choose ID` the alternative (with `--answer` for its editable blocks). A throwaway kind cluster makes a good "own cluster".

## Client code (`packages:`)

For a snippet of client code, such as a producer showing one setting, write it as a `python`, `js` or `go` run block that lists its libraries, rather than a file block, a virtualenv step and a block that runs the file:

```yaml
lang: python
packages: [confluent-kafka==2.16.1]
timeout: 60
```

- The first run installs them, into `lab/.packages`, shared by every block with the same packages. It shows the installer's progress in red, and gets five extra minutes. Say so on the page.
- Pin every package: `check.js` reports any without a version.
- The code runs in the note's folder, so it can read `lab/` files, or run `bash lab/brokers.sh` for addresses that come from the lab.
- A block's revert defaults to its own language. To undo with shell commands, use `revert: { lang: bash, run: … }`.
- Delete `lab/.packages` in the setup page's teardown and in its last revert.
- The tools check needs `python3 -c 'import venv'`, `npm` or `go`, for the languages the course uses.
- It isn't for a process that keeps running: the block waits for it. Make the code finish (a consumer that stops when idle, a producer that exits mid-transaction to leave it open), or start it with `nohup` from a project the page builds.
- When setting up the project is what the page teaches (a virtualenv, `npm init`, a `pom.xml`), keep the file blocks: the learner should see, and keep, the files. Getting Started with Redpanda's page 6 is like that; Producers and Consumers' Transactions page uses `packages:`.

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
- Background processes need `nohup`, a PID file, and a revert that kills them. If the PID is a script's (`nohup bash lab/consumer.sh &`), the commands it started are its children and keep running when it's killed: stop them too, with `pkill -P "$pid"; kill "$pid"`.
- `rpk topic consume -g` doesn't commit a partition whose newest record was written before the partition's leader last changed, so the group's lag on it never reaches 0. Leaders move soon after a cluster starts (the leader balancer). Before checking that a group drains to zero, produce a fresh record to every partition, for example 30 records with distinct keys.
- An exercise whose point is a failing command (a produce that times out, `kubectl auth can-i` answering `no`, which exits 1) stops Run all at it. Mark it `manual: true`, say on the page that the red is the answer, and check the outcome in a separate block that expects it.
- Run all runs an exercise straight after the one before it. If that one created something that takes time (a pod starting), put a block that waits for it in between, so the next exercise isn't run too early.
- `rpk topic consume -g` can't use `-o :end`; to read a group's backlog and exit, use `-n` with the lag.
- Certificates need every name clients will use (service names, `localhost`), or an upgrade later fails TLS.
- `rpk cluster health` exits non-zero (10) while the cluster is unhealthy, not only when it's unreachable. Use `rpk cluster info` to test it's reachable, in prerequisites and in revert guards alike: a guard that tests health skips the undo whenever the cluster is briefly unhealthy. To wait for health, require several healthy readings in a row: just after a restart it flips back and forth.
- A long-running process the learner would leave in a second terminal, such as a consumer, becomes a background block (`nohup`, a PID file, and a revert that kills it) with exercises around it.
- A command that waits forever, such as a consumer without a count, is fine in an exercise: the learner presses ■ to stop it, as they'd press Ctrl-C. Say so on the page, and don't gate it with a pattern. Mention that a stopping point (`-o :end`, `-n`) lets the lines after it run too, and give the block a `timeout` long enough to look at the output. Blocks the course itself runs, such as checks, must stop on their own.
- Charts and images move. Pin versions, by digest where it matters, and check they're current when writing.
