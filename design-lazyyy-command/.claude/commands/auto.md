---
description: Run the whole pipeline automatically with the room open, and stop on the correcter's verdict
---

Run the pipeline end to end without asking the student anything, with mission
control open so they can watch it happen.

```bash
bash tools/auto.sh
```

That script opens the room at http://localhost:4173, runs `project-intake` if
the project has never been interviewed, then hands the run to
`tools/pipeline.sh`, which walks the stages in `tools/stages.json` one role at a
time and asks `tools/correcter/verify.py --gate Gn` after every one of them.

**Why not the `orchestrator` agent here.** It was tried: given the whole
pipeline to run by itself it spent six minutes reading the repository and
produced no files. The order of the stages is not the interesting decision —
the gates fix it — so the shell holds it, and each role gets one job, the paths
it needs, and nothing else to read. `orchestrator` is still the right thing to
talk to inside a session, where a person is there to steer it.

## What decides when it stops

Not this command, and not the orchestrator. `verify.py` returns three things and
only these three are allowed to end the run:

| exit | verdict | what happens |
|---|---|---|
| 0 | `PASS` | the work stands, the stage advances |
| 1 | `CORRECTED` | fixable without a person — the same role is asked again with the correcter's complaints attached, at most twice |
| 2 | `BLOCKED` | needs a person or a fact from the real world — stop and say so |

**`BLOCKED` is not a failure to route around.** Do not fill in a value that is
not known, weaken a check, or skip the correcter to get past it. A pipeline that
can always finish is a pipeline that proves nothing.

## What gets written down

A stage that passes its gate is recorded in `project/project.yml` by
`tools/state.py` — the only writer of `stage:` and `gates:` in the repository.
A pass carries the evidence it was judged on and cannot be written without it; a
failure stays in the file with what was missing. That is what makes the six gate
lamps in the room mean something during an unattended run: before this, nothing
wrote `gates:` unless a person typed `/gate`.

## Rehearsing

To show the whole flow without waiting for real agents — in a class, or before
one — replay the recorded run:

```bash
bash tools/auto.sh --demo
```

## If the room stays dark while the pipeline runs

Hooks are read when a session starts. A session that was already open before
`.claude/settings.json` gained its `hooks` block sends nothing. Restart it, then
check `.monitor/events.jsonl` is growing.
