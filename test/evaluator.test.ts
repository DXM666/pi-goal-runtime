import assert from "node:assert/strict";
import test from "node:test";
import { buildEvaluationPrompt } from "../src/evaluator.js";
import type { GoalState } from "../src/core.js";

test("evaluator prompt includes goal and hard-gate result", () => {
  const goal = { condition: "all tests pass" } as GoalState;
  const prompt = buildEvaluationPrompt(goal, "GOAL_COMPLETE", {
    ok: false,
    command: "npm test",
    exitCode: 1,
    output: "one test failed",
  });
  assert.match(prompt, /all tests pass/);
  assert.match(prompt, /Result: FAIL/);
  assert.match(prompt, /complete must be false/);
});

test("evaluator prompt reports PASS when verifier succeeds", () => {
  const goal = { condition: "build succeeds" } as GoalState;
  const prompt = buildEvaluationPrompt(goal, "Some progress made", {
    ok: true,
    command: "npm run build",
    exitCode: 0,
    output: "build complete",
  });
  assert.match(prompt, /Result: PASS/);
  assert.match(prompt, /build complete/);
});

test("evaluator prompt handles no verifier configured", () => {
  const goal = { condition: "write docs" } as GoalState;
  const prompt = buildEvaluationPrompt(goal, "wrote API docs", {
    ok: true,
    output: "No deterministic verifier configured.",
  });
  assert.match(prompt, /none configured/);
});
