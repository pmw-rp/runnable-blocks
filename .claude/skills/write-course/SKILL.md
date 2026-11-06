---
name: write-course
description: Write, port or extend an interactive training course as Obsidian notes that use the Runnable Blocks plugin (```run and ```file blocks with checks, prerequisites, reverts and exercises), then test it end to end against a real lab. Use this whenever someone wants a new course, lab, workshop, tutorial or hands-on exercise in the Learning Path vault; wants to migrate an existing lab (an Instruqt track, a GitHub demo repo, a README walkthrough, a VM-based workshop) into Obsidian; or wants to add lessons, exercises, checks, dependencies or teardown to an existing course, even if they don't mention Runnable Blocks by name.
---

# Writing a Runnable Blocks course

A course is a folder of Obsidian notes. Each note is a page of prose with runnable cells: `run` blocks that execute commands, and `file` blocks that write files the commands use. Blocks can check their own result, depend on earlier blocks (in the same note or another), require a command to succeed or the learner's code to match a pattern, undo themselves, and run only once. The learner presses ▶ on each block, or **Run all**, and sees green, red or blocked.

The plugin lives in this repository. Its `README.md`, at the repository root, is the full reference for the block format. `references/block-format.md` is a condensed version with the patterns that work well in courses: read it before writing blocks.

The vault is at `/Users/pmw/Documents/LearningPath/Learning Path`, unless the user says otherwise. The existing courses there, `Day 2 Operations - Operator/`, `Shadow Linking/` and `Redpanda with Ansible/`, are good models: read one page of whichever is closest to the new course before starting.

## What makes a good course here

A learner should be able to work through the pages in order, with every check green, without knowing anything the page doesn't tell them. When something goes wrong, the page should make it obvious what, and Reset should put things back. In practice:

- **Every step that changes something is followed by a check** that prints one short, stable line and has `expect.output`. "cert-manager: ready, operator: ready" is a good check line. Raw command output with timestamps, ages or random names is not.
- **Every step depends on what it needs**, with `depends-on`, so it's blocked, with a reason, until those steps have passed.
- **Every step that changes something says how to undo it**, with `revert:`, unless it can't be undone. Then it's `idempotent: false` and the page says why.
- **Run all works.** Blocks run back to back with no human pause, so anything asynchronous needs an explicit wait.
- **The course has actually been run, end to end, against a real lab**, and torn down again, before it's handed over. Most bugs in the existing courses were only found this way.

## Workflow

### 1. Understand the source and the target

If porting an existing lab, read all of it first: the setup scripts, each assignment's text, the check/solve scripts, and any files it ships. Note what the learner does, what's checked, and what the environment is. Then decide how it maps onto a local lab: the existing courses replace VMs with **kind** clusters, Docker containers, or `cm` pseudo-VMs. Ask the user if the target environment isn't clear.

Then try the environment for real before writing any checks: start it, and run the commands the course will use, to see their exact output, timing and failure modes. A check written against guessed output is the commonest bug. Ports a tool "uses by default" may not be the ones it binds, so look at what it actually binds before deciding there's a clash, and don't stop someone else's process on a guess.

Check current versions of everything the lab installs (charts, operators, images, CLIs) rather than copying old pins from the source, and pin them in the page. A lab that floats on `latest` breaks without anyone changing it.

Focus each page on the thing being taught. In the Ansible course, the container tooling was only scaffolding: the first draft was about the tooling, and the user had to ask for it to be about Ansible.

### 2. Plan the pages

- `1 Setup.md`: requirements (as a callout), a tools check, building the lab, and a **When you're finished** section that explains Reset all, plus an **If a reset gets stuck** manual teardown block.
- One page per lesson, `2 Topic.md`, `3 Topic.md`, … (or one folder per lesson, as in Day 2 Operations), each opening with what it teaches and a link to the setup page.
- Each lesson ends with **Your turn**: an exercise where the learner writes the command or edits the file, checked automatically.

Link pages with `[[wikilinks]]`, put tags in frontmatter, and tell the learner up front how long setup takes.

### 3. Write the setup page

Follow the shape of `Shadow Linking/1 Setup.md`:

1. **Tools check**: one block that checks every command-line tool and that Docker is running, and prints `all set` (`expect.output: all set`). Name the install command in the requirements callout.
2. **For each step**: a short explanation, any `file` blocks it needs (configs go in `lab/` next to the note), the action block, then its check block.
3. **Dependencies**: each action depends on the previous action. Each check depends on its action.
4. **Reverts**: each action gets a revert that undoes exactly that step, and copes with the step being half done or already undone:
   - Start reverts that need the cluster with a guard: `kind get clusters 2>/dev/null | grep -qx NAME || { echo "The cluster is already gone, so there is nothing to undo"; exit 0; }`.
   - Name the cluster explicitly: `kubectl --context kind-NAME`, `helm --kube-context kind-NAME`. Otherwise a revert run while another lab is current deletes namespaces from the wrong cluster.
   - Use `--ignore-not-found`, `--wait`, and `|| true` where something may already be gone.
5. **Waits**: after anything asynchronous, wait for it inside the action block, not in a separate block the learner might skip. `kind create cluster` returns before its nodes are Ready, so follow it with `kubectl wait --for=condition=Ready nodes --all`. Use `kubectl wait`, `helm --wait`, or a bounded loop: `for i in $(seq 1 30); do CHECK && break; sleep 1; done`. Raise `timeout:` on blocks that take more than 30 seconds.
6. **Port forwards and profiles**: start background processes with `nohup … &`, record their PIDs in `lab/*.pid`, and make the block safe to run again (kill the old ones first). Its revert kills them.
7. **Teardown**: Reset all, bottom up, is the normal teardown. Keep a `manual: true` "if a reset gets stuck" block that deletes everything at once.

### 4. Write each lesson

- **The first block needs the lab.** Make it depend on the setup page's last checks, by id, *and* require a command that proves the lab is running now. The saved result of a setup block can be days old:
  ```yaml
  depends-on:
    - <setup's health check id>
  requires:
    - command: rpk --profile source cluster info >/dev/null 2>&1
      timeout: 20
      message: Set up the lab in 1 Setup first. If it's set up, run its port forwards block again
  ```
  Check that the lab can be *reached*, not that it's *healthy*. `rpk cluster health` exits 10 whenever the cluster reports itself unhealthy, which happens for a few seconds after ordinary operations, so as a prerequisite it blocks pages at random. Where a step needs a healthy cluster, wait for health inside that step instead.
- **Chain the rest** with `depends-on`. A check that reads what an earlier step produced depends on that step.
- **Decide, per block, whether it can be undone.** Some things genuinely can't: in Shadow Linking, a topic mirrored to the shadow cluster can't be deleted while the link exists, and recreating it on the source breaks the mirror. Those blocks are `idempotent: false` with no revert, and the page says so in a callout, with how to start over (usually: rebuild the lab). Don't write a revert that only half works. Test what's undoable against the real system rather than guessing.
- **Replication, propagation and eventual consistency need waits**, as in setup. Several checks in the existing courses passed by hand and failed under Run all.

### 5. Write the exercises

An exercise is an `editable: true` block with a placeholder (`# your command here`) or a starting file, and a separate check block after it that verifies the *result*, not the command. Prefer checking observable state ("orders has 3 partitions on the shadow cluster") over checking the command text, so any correct answer passes.

**When a wrong answer is hard to undo, gate the block with `matches:` patterns**, so it can't run until the command has the right shape. Add one pattern per mistake, each with its own `message`, because the learner sees every failing message as a to-do list.

Restrict only the command the task is about, not the whole block. Learners look around first: `docker ps` before `docker kill`, `--help` before writing the command, `rpk topic describe` to find a leader. So allow any other lines, even on their own before the task's command is written, and restrict the task's command only: at most once, on a line of its own, with the constraints applied to that line. `references/block-format.md` has the patterns. RP Streaming 101's exercises are the model. Then:

- Test the patterns with `scripts/check.js NOTE… --patterns ID 'cmd' 'cmd' …`, against several correct variants (flag order, `--flag=value`, short flags) and every mistake you can think of. The patterns are JavaScript regular expressions.
- Messages say what to do ("Give it 3 partitions, with -p 3"), not what the pattern is.
- Since the learner may run the box several times while exploring, don't mark it `idempotent: false`. If running the task's command twice would do harm, guard it with a `command:` prerequisite that checks the lab is in its starting state.

For file exercises, use an editable `file` block with a `check:` script that exits non-zero with a helpful message for each mistake (see Schema shadowing's `region` exercise), and make the block that uses the file depend on it.

### 6. Check the notes parse

Install the scripts' one dependency once, then check every note of the course together, so dependencies between notes resolve:

```bash
npm install --prefix .claude/skills/write-course/scripts   # once
node .claude/skills/write-course/scripts/check.js "<vault>/<Course>/"*.md
```

It reports each block's settings, and any problem: YAML that doesn't parse, a missing or duplicate id, a dependency that doesn't exist or is below its block, or a `kubectl` revert without `--context`. Fix them all.

### 7. Run it end to end

Run every page against a real lab with `scripts/run.js`, in order, in the background, since setup takes minutes:

```bash
R=.claude/skills/write-course/scripts/run.js
cd "<vault>/<Course>"
node $R "1 Setup.md" && node $R "2 Topic.md" --answer <exercise id> '<the correct command>' && …
```

When an exercise's answer depends on the lab, for example "kill the broker that leads partition 0", run the page in two goes: `--only` the block that reveals it, then `--from` the exercise with an `--answer` built from what it showed.

It runs blocks as Run all would, enforces prerequisites (including across pages, through a state file), and checks each result with the plugin's own logic. Its summary lists every block as ok, FAIL or BLOCKED. Any FAIL is a bug in the course: fix the page and run that page again. Also run each exercise once with a wrong answer, to see it blocked or failing as intended.

Then test the teardown: `node $R "<page>" --reverts` for each page, lessons first and setup last, and run the setup reverts a second time to check they cope with everything already being gone.

Tell the user before building a lab. It uses Docker and minutes of time, and it may clash with a lab they're running. Leave nothing running afterwards. Blocks run by the script aren't recorded in the notes, so the user can't Reset them in Obsidian.

### 8. Hand it over

- Make sure no note contains `result:`, `original:` or `learner:` entries from testing, unless the user wants them. They're the learner's progress, not course content. A block with `original:` has a learner's answer below `---`: Reset it, or move the original back below `---` and delete the entry.
- Lab output (`lab/`) is ignored by the vault's `.gitignore`. Don't commit generated files, keys or certificates.
- Summarise for the user: the pages, what each teaches, what was tested and how, what can't be undone, and anything you couldn't test.
- Commit only when asked.

## Writing the prose

Write for a learner who is doing this for the first time:

- Open each step with what it does and why, in a sentence or two, then the block.
- Say what to expect when it isn't obvious: "kind writes its progress to stderr, so it shows in red; that's normal", "this takes a few minutes".
- Use callouts: `> [!info] Requirements`, `> [!warning]` for things that can't be undone.
- Use tables for ports, namespaces and components.
- End each page with a link to the next.
