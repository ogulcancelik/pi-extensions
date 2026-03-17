# pi-goal

Autonomous goal pursuit with sub-agent workers for [pi](https://github.com/badlogic/pi-mono). Break work into tasks, spawn isolated workers, track progress via files on disk.

## Install

```bash
pi install npm:@ogulcancelik/pi-goal
```

Or add manually to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@ogulcancelik/pi-goal"]
}
```

## What it does

Turns multi-step work into structured goals with task breakdowns. You discuss a goal with the agent, it creates task documents with specific file paths and acceptance criteria, then spawns fresh worker agents to implement each task independently. Progress lives on disk — survives compaction, restarts, and context loss.

## How it works

1. You and the agent discuss a goal
2. Agent creates structured tasks with `goal add_task` — rich markdown docs with file paths, constraints, and acceptance criteria
3. Agent runs workers with `goal run` — each gets a fresh pi subprocess, reads only its task doc, implements immediately
4. Results and learnings accumulate on disk in the goal directory
5. Agent stays grounded via system prompt injection — active goal state is re-injected every turn, even after compaction

## File structure

```
.pi/goals/
├── ACTIVE                          # slug of active goal
└── <goal-slug>/
    ├── GOAL.md                     # goal description
    ├── STATE.json                  # machine-readable state (tasks, status)
    ├── LEARNINGS.md                # cross-task knowledge (auto-appended by workers)
    ├── tasks/
    │   ├── 01-<task-name>.md       # task spec (what workers read)
    │   └── 02-<task-name>.md
    ├── results/
    │   ├── 01.md                   # worker output
    │   └── 02.md
    └── sessions/                   # worker session logs (for observability)
```

## Actions

| Action     | Description                                                              |
|------------|--------------------------------------------------------------------------|
| `create`   | Create a new goal with name, description, optional `workerModel`         |
| `add_task` | Add a task with a name and full markdown spec                            |
| `run`      | Execute all pending tasks sequentially with isolated worker agents        |
| `status`   | Check current goal progress, task states, and learnings                  |

## Worker behavior

- Fresh `pi` subprocess per task — no shared context between workers
- Tools available: `read`, `edit`, `write`, `grep`, `find`, `ls` (no bash)
- Workers read their task doc first, then implement immediately
- Learnings from each worker are auto-extracted and appended to `LEARNINGS.md`
- Worker sessions are saved in the goal directory for observability

## Configuration

Pass `workerModel` when creating a goal to control which model runs workers. Defaults to the facilitator's current model.

```
goal create —  name: "my goal", workerModel: "anthropic/claude-sonnet-4-20250514"
```

This is v0.1 — more configuration options coming.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) v0.40+

## License

MIT
