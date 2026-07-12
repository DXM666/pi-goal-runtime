# Pi Goal Runtime

> **Language:** [中文](README.md) | English

A persistent, verifiable outer loop for [Pi](https://pi.dev/docs/latest). It keeps an agent working across settled turns until an independent evaluator confirms the goal, an optional deterministic verifier passes, or a safety stop is reached.

## What it adds

- `/goal` completion-condition loop, similar to Claude Code's goal workflow.
- Independent evaluation using the active Pi model and provider credentials.
- Optional hard gate using any shell command, such as tests or lint.
- Session-persisted state that survives reload and resume.
- Explicit `running`, `blocked`, `paused`, `budgetLimited`, and `achieved` states.
- Turn, time, token/cost, repeated-result, and evaluator-error limits.
- Context compaction when the context window exceeds a threshold.
- Goal Hook system for custom event handlers (pre-turn, post-turn, on-blocked, on-achieved, on-paused, on-budget-limited, on-compact).
- Goal history tracking across multiple goals in a session.
- Exponential backoff retry for the independent evaluator.
- Progress feedback injected into the next agent turn.

## Requirements

- Node.js 20 or newer.
- Pi 0.80.6 or newer.
- A working model/provider configured in Pi.

## Install in Pi

```bash
npm install
pi install /absolute/path/to/pi-goal-runtime
```

During development:

```bash
pi --extension ./src/goal.ts
```

Remove:

```bash
pi remove /absolute/path/to/pi-goal-runtime
```

## Commands

```text
/goal <condition> [--verify <command>] [--max-turns N] [--max-minutes N] [--max-no-progress N] [--max-tokens N] [--max-cost N] [--compact-on-oversize]
/goal-status
/goal pause | clear | stop | cancel
/goal history
/goal clear-history
/goal-resume
/goal-hook [event-name]
```

Headless/CI execution:

```bash
pi --print --goal-condition "all tests pass" --goal-max-turns 20 "Fix the failing tests"
```

Example:

```text
/goal all tests pass and lint is clean --verify npm test --max-turns 30 --max-minutes 240 --max-tokens 100000 --max-cost 1.00
```

### Options

| Option | Default | Meaning |
|---|---:|---|
| `--max-turns` | 30 | Maximum evaluated worker runs |
| `--max-minutes` | 240 | Wall-clock duration limit |
| `--max-no-progress` | 3 | Repeated identical-result limit |
| `--max-tokens` | none | Token budget (input + output + cache) |
| `--max-cost` | none | Cost budget in USD |
| `--compact-on-oversize` | false | Auto-compact when context > 80% |

## Token and Cost Budgets

When `--max-tokens` or `--max-cost` is configured, the extension tracks cumulative token usage from both worker turns and evaluator calls. When the budget is exceeded, the goal enters a `budgetLimited` paused state instead of crashing.

Budget checks happen at two points:
1. Before running the deterministic verifier (early exit to save costs).
2. After the evaluator call (catches evaluator-driven overages).

## Context Compaction

When `--compact-on-oversize` is enabled, the extension monitors context usage via Pi's `getContextUsage()` API. When usage exceeds 80% of the context window, it triggers compaction with a custom instruction to preserve goal progress and next actions.

## Goal Hooks

| Event | When | Can block? |
|---|---|:---:|
| `pre-turn` | Before verification and evaluation runs | Yes |
| `post-turn` | After evaluation completes | No |
| `on-blocked` | When the worker reports a blocker | No |
| `on-achieved` | When the goal is achieved | No |
| `on-paused` | When the goal pauses for any reason | No |
| `on-budget-limited` | When token/cost budget is exceeded | No |
| `on-compact` | When context compaction is triggered | No |

## Completion protocol

After every `agent_settled` event:

1. The configured verification command runs in the active working directory.
2. A fresh model call evaluates the goal, worker report, and verifier evidence.
3. The goal becomes achieved only when both evaluator and hard gate pass.
4. Otherwise, the evaluator's reason and next action start another turn.

## Safety model

- The extension does not change Pi's tool permissions.
- A blocked verdict stops automatic execution instead of repeatedly guessing.
- Three consecutive evaluator failures pause the goal (with exponential backoff retry).
- Token/cost limits pause the goal; they do not falsely mark it complete.

## Project Structure

```
src/
├── goal.ts          # Extension entry: registers commands, flags, event handlers
├── core.ts          # Core utilities: arg parsing, verification, budget checks
├── evaluator.ts     # Independent model evaluation + cost estimation
├── hooks.ts         # Goal Hook event system
├── types.ts         # Centralized type declarations (interfaces & types)
test/
├── core.test.ts     # Core utility tests
└── evaluator.test.ts# Evaluator tests
```

## Development

```bash
npm ci
npm run check
npm test
```
