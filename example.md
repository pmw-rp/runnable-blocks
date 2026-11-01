# Runnable Blocks demo

Press ▶ on any block, or run **Runnable Blocks: Run all blocks in current note** from the command palette.

Each block's settings go in a YAML header at the top, ended by a `---` line. The code or file content goes below it. The header is hidden in the rendered block. Each block also has an `id:`, a UUID unique within the note. A block without one gets one the first time it runs.

## Plain execution

```run
id: 60e03def-506a-4c91-a533-64c1076b9586
lang: bash
---
echo "Running in: $(pwd)"
ls | head -5
```

## Output checked against an exact value or an MD5

```run
id: 379539c5-a2b9-4e0d-ba3e-708aa91a63dd
lang: bash
expect:
  output: Hello from Obsidian
---
echo "Hello from Obsidian"
```

```run
id: 8cb8b39a-0ce8-40e0-9f2e-0718bb41958f
lang: python
expect:
  md5: 6c8349cc7260ae62e3b1396831a8398f
---
print(sum(range(10)))
```

## A failing check

```run
id: 9b254b54-415c-4cb2-b441-146614475f7e
lang: bash
expect:
  md5: 9b15e74059cb1df9eb06a08ef234018e
---
echo "this output differs"
```

## Exercise

Print the sum of the integers 1 to 100 with one shell pipeline. This block is `editable`: type your answer straight into it and press ▶ (or Shift+Enter).

```run
id: d8327023-5739-4ecc-a418-e407e7b828e5
lang: bash
editable: true
expect:
  md5: 8977ecbb8cb82d77fb091c7a7f186163
---
# your command here
```

## Exercise with an exact command

Here the command itself is checked too (`command-md5`). Try `seq 1 100 | paste -sd+ - | bc`, then try another command that prints the same number and watch the command check fail.

```run
id: 0ed13239-054e-44f4-b3da-d8875feee263
lang: bash
editable: true
expect:
  md5: 8977ecbb8cb82d77fb091c7a7f186163
  command-md5: e69b4f45ed0327caa6fab84ce09cc4bb
---
# your command here
```

## Editing files

A `file` block writes its content to `path`, relative to the note's folder. Its header can also say how to validate the file. An `editable` file block stays in sync with the file: as you type, the file is rewritten and checked, and the border turns green or red. Changes made to the file elsewhere show up in the block. Your version is stored in the note, and the original stays alongside it, so **Reset** can go back to it.

### Check a value pulled out of the file

Change `replicas` to `3`.

```file
id: 427571fd-4ed3-4450-93ed-f41dcfc359fd
path: demo/app.yaml
editable: true
check:
  lang: bash
  run: awk '/replicas:/ {print $2}' "$FILE"
  expect:
    output: "3"
---
service:
  name: web
  image: nginx:1.25
  replicas: 1
  ports:
    - 80
```

### Check a hash of a value pulled out of the file

Same idea, but the expected value is hidden behind an MD5. Change the image to `nginx:1.27`.

```file
id: 8726f24c-00fc-409b-adc3-96baecc93331
path: demo/deploy.yaml
editable: true
check:
  run: awk '/image:/ {print $2}' "$FILE"
  expect:
    md5: 72c3fe04e3ed7af4b331fe00852acfa7
---
image: nginx:1.25
pullPolicy: IfNotPresent
```

### Check the exact content

Set `MODE` to `production`. The whole file has to match.

```file
id: ace20e84-d34c-48ee-ab2c-1089f088625d
path: demo/.env
editable: true
expect:
  content: MODE=production
---
MODE=development
```

### Check a hash of the content

Make the file say exactly `Hello, world!`.

```file
id: afbd31aa-6dee-4e58-8d08-1333c2d90b4b
path: demo/hello.txt
editable: true
expect:
  md5: 6cd3556deb0da54bca060b4c39479839
---
Hello world
```

### Check with a validator

A `check` with no expected value passes when the command exits with 0. Fix the JSON (hint: there's a trailing comma).

```file
id: 12ed3e3b-cc28-43d6-9011-e2bae6223cf2
path: demo/config.json
editable: true
check:
  lang: python
  run: |
    import json, os
    json.load(open(os.environ["FILE"]))
    print("valid JSON")
---
{
  "name": "web",
  "port": 8080,
}
```

### Using a file from a run block

Run blocks see the files written above them. Edited files are written automatically first.

```run
id: 51541899-0895-4580-b391-06458dbb7fa3
lang: bash
---
cat demo/app.yaml
```

## stderr, exit codes and timeouts

```run
id: 2da554d8-7dad-46ba-aea9-a97e1e53bd04
lang: bash
---
echo "to stdout"
echo "to stderr" >&2
exit 3
```

```run
id: cff08e0d-2827-4862-8de6-870b076b546c
lang: bash
timeout: 2
---
echo "sleeping…"
sleep 10
```

## Go

Go blocks are complete programs, with `package main` and `func main()`. They're compiled, then run. The first run takes a few seconds while Go builds its standard library, and later runs use its build cache.

```run
id: 3ea33faa-5bae-4452-9efd-063414630520
lang: go
expect:
  output: "Hello from Go: 5050"
---
package main

import "fmt"

func main() {
	sum := 0
	for i := 1; i <= 100; i++ {
		sum += i
	}
	fmt.Printf("Hello from Go: %d\n", sum)
}
```

## Dependencies

A block can depend on blocks above it, by listing their ids in `depends-on`. Until each of them has run successfully (passed its checks, or run cleanly if it has none), the block is **blocked**: it can't run, and it says what it's waiting for. To get a block's id for `depends-on`, use **Copy block id** in its **#** menu.

This block starts the chain:

```run
id: 3d7bd56a-63be-49af-97e8-49bd9794886a
lang: bash
---
mkdir -p demo
date > demo/started.txt
echo "Started at $(cat demo/started.txt)"
```

This one is blocked until the block above has run:

```run
id: d94dcec2-5319-42dc-ba43-adde7ef8f475
lang: bash
depends-on: 3d7bd56a-63be-49af-97e8-49bd9794886a
---
echo "The first block ran at $(cat demo/started.txt)"
```

A block that fails keeps the blocks depending on it blocked. This one fails until you change `exit 1` to `exit 0` and run it again:

```run
id: 99579044-9bb4-4e1c-93fc-1604cef37e39
lang: bash
editable: true
---
echo "Checking the environment..."
exit 1
```

This one depends on both the first block and the one you just edited, so it's blocked until both have run successfully:

```run
id: 87124527-faa0-4e28-8231-956d8cb1c5db
lang: bash
depends-on:
  - 3d7bd56a-63be-49af-97e8-49bd9794886a
  - 99579044-9bb4-4e1c-93fc-1604cef37e39
---
echo "Both dependencies are complete"
```

## Revert and reset

A block can say how to undo what it did, with `revert:`. Blocks that have one show a **Revert** button (↶) once they've run. If the revert works, the block is back to not having run. Every block also has **Reset** (the eraser): it reverts the block if it can, then clears its output.

Run these two blocks. The second depends on the first:

```run
id: f9d67ceb-2bd9-4c75-81ba-41b580008ff5
lang: bash
revert: rm -rf demo/scratch
---
mkdir -p demo/scratch
echo "hello" > demo/scratch/greeting.txt
ls demo/scratch
```

```run
id: 28419f49-fa1d-4909-990f-d0565e9b4e55
lang: bash
depends-on: f9d67ceb-2bd9-4c75-81ba-41b580008ff5
revert: rm -f demo/scratch/copy.txt
---
cp demo/scratch/greeting.txt demo/scratch/copy.txt
ls demo/scratch
```

Now try reverting the first block. You can't yet: like undo, you revert in reverse order, and the second block depends on the first. Revert the second block, then the first. **Reset all blocks in current note**, in the command palette, does the whole note from the bottom up.

A file block's revert gets the file's path in `$FILE`, as its check does:

```file
id: f2672559-09f1-4c4e-b070-dc98ac271888
path: demo/notes.txt
revert: rm -f "$FILE"
---
Notes written by a file block.
```

## Inside a callout

> [!example] Node
> ```run
> id: 9da51471-a354-49a2-a084-eeee42f10f10
> lang: js
> ---
> console.log([1, 2, 3].map(n => n * n).join(" "))
> ```
