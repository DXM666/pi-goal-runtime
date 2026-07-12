import assert from "node:assert/strict";
import test from "node:test";
import {
  claimsCompletion,
  parseEvaluation,
  parseGoalArgs,
  timeLimitExceeded,
  tokenBudgetExceeded,
  createGoalResult,
  type GoalState,
} from "../src/core.js";
import { runHooks } from "../src/hooks.js";

test("parses goal options", () => {
  const result = parseGoalArgs("all tests pass --verify npm test --max-turns 12 --max-minutes 60");
  assert.equal(result.condition, "all tests pass");
  assert.equal(result.verifyCommand, "npm test");
  assert.equal(result.maxTurns, 12);
  assert.equal(result.maxMinutes, 60);
});

test("parses token and cost budget options", () => {
  const result = parseGoalArgs("all tests pass --max-tokens 50000 --max-cost 0.50 --compact-on-oversize");
  assert.equal(result.maxTokens, 50000);
  assert.equal(result.maxCost, 0.50);
  assert.equal(result.compactOnOversize, true);
});

test("compact-on-oversize accepts yes", () => {
  const result = parseGoalArgs("fix bug --compact-on-oversize yes");
  assert.equal(result.compactOnOversize, true);
});

test("compact-on-oversize defaults to false", () => {
  const result = parseGoalArgs("fix bug");
  assert.equal(result.compactOnOversize, false);
});

test("requires a standalone completion marker", () => {
  assert.equal(claimsCompletion("done\nGOAL_COMPLETE\n"), true);
  assert.equal(claimsCompletion("I might say GOAL_COMPLETE later"), false);
});

test("enforces the wall clock budget", () => {
  const state = { startedAt: 0, maxMinutes: 2 } as GoalState;
  assert.equal(timeLimitExceeded(state, 119_999), false);
  assert.equal(timeLimitExceeded(state, 120_000), true);
});

test("enforces the token budget", () => {
  const state = { totalTokensUsed: 900, maxTokens: 1000 } as GoalState;
  assert.equal(tokenBudgetExceeded(state), false);
  state.totalTokensUsed = 1000;
  assert.equal(tokenBudgetExceeded(state), true);
  state.totalTokensUsed = 1100;
  assert.equal(tokenBudgetExceeded(state), true);
});

test("enforces the cost budget", () => {
  const state = { totalCostUsed: 0.49, maxCost: 0.50 } as GoalState;
  assert.equal(tokenBudgetExceeded(state), false);
  state.totalCostUsed = 0.50;
  assert.equal(tokenBudgetExceeded(state), true);
});

test("token budget with no limit configured", () => {
  const state = { totalTokensUsed: 999999 } as GoalState;
  assert.equal(tokenBudgetExceeded(state), false);
});

test("parses a strict independent evaluator verdict", () => {
  const result = parseEvaluation('{"complete":false,"blocked":false,"reason":"tests fail","nextAction":"fix test"}');
  assert.equal(result.complete, false);
  assert.equal(result.reason, "tests fail");
  assert.equal(result.nextAction, "fix test");
});

test("rejects malformed evaluator output", () => {
  assert.throws(() => parseEvaluation("looks good"), /no JSON/i);
});

test("createGoalResult captures final state", () => {
  const state = {
    condition: "fix tests",
    status: "achieved",
    turns: 5,
    totalTokensUsed: 10000,
    totalCostUsed: 0.05,
    startedAt: 1000,
    lastReason: "All tests pass",
  } as GoalState;
  const result = createGoalResult(state, 5000);
  assert.equal(result.condition, "fix tests");
  assert.equal(result.turns, 5);
  assert.equal(result.totalTokensUsed, 10000);
  assert.equal(result.endedAt, 5000);
});

test("runHooks fires matching hooks", async () => {
  let fired = 0;
  const hooks = [
    { event: "pre-turn" as const, handler: () => { fired++; } },
    { event: "post-turn" as const, handler: () => { fired++; } },
  ];
  await runHooks(hooks, "pre-turn", {} as any);
  assert.equal(fired, 1);
});

test("runHooks respects block result", async () => {
  const hooks = [
    { event: "pre-turn" as const, handler: () => ({ block: true, reason: "stop" }) },
    { event: "pre-turn" as const, handler: () => { throw new Error("should not fire"); } },
  ];
  const result = await runHooks(hooks, "pre-turn", {} as any);
  assert.equal(result.block, true);
  assert.equal(result.reason, "stop");
});

test("runHooks swallows hook errors", async () => {
  const hooks = [
    { event: "post-turn" as const, handler: () => { throw new Error("hook error"); } },
  ];
  const result = await runHooks(hooks, "post-turn", {} as any);
  assert.equal(result.block, false);
});
