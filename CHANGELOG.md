# Changelog

## 0.3.0

- Added token and cost budget limits (--max-tokens, --max-cost) with soft-stop (budgetLimited state).
- Added context compaction when context window exceeds 80% (--compact-on-oversize).
- Added Goal Hook event system with 7 events: pre-turn, post-turn, on-blocked, on-achieved, on-paused, on-budget-limited, on-compact.
- Added exponential backoff retry for independent evaluator (3 attempts: 1s, 2s, 4s delays).
- Added goal history tracking and /goal history / /goal clear-history commands.
- Added /goal-hook command to inspect registered hooks.
- Extracted token usage tracking from worker and evaluator model calls.
- Added hooks.ts module with typed hook system and error isolation.
- Bumped version to 0.3.0.

## 0.2.0

- Added an independent model evaluator after every settled agent run.
- Combined model judgment with an optional deterministic command gate.
- Added explicit blocked-state handling and evaluator failure limits.
- Added migration support for 0.1 session entries.
- Added CI and broader evaluator tests.
- Added a Harbor adapter for official Terminal-Bench 2.0 evaluation.
- Added a headless `--goal-condition` entry point for CI and benchmark runners.

## 0.1.0

- Initial persistent session-scoped goal loop.
- Added turn, wall-clock, and no-progress limits.
- Added optional deterministic verification commands.
