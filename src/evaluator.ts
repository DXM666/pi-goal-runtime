// Pi Goal Runtime — 独立评估器
// 调用模型作为独立审阅者判断目标是否完成，避免 worker 自评估的偏差

import { complete, type Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { parseEvaluation } from "./core.js";
import type { EvaluationResult, GoalState, VerificationResult } from "./types.js";

// ─────────────────────────────────────
// 主评估函数
// ─────────────────────────────────────

/**
 * 调用模型作为独立评估者判断目标是否完成
 * - reasoningEffort 固定为 "low"（评估任务不需要深度推理）
 * - 返回结构化的 EvaluationResult
 */
export async function evaluateGoal(options: {
  goal: GoalState;
  workerOutput: string;
  verification: VerificationResult;
  model: Model<any> | undefined;
  modelRegistry: ModelRegistry;
}): Promise<EvaluationResult> {
  if (!options.model) throw new Error("No active model is available for goal evaluation");

  const auth = await options.modelRegistry.getApiKeyAndHeaders(options.model);
  if (!auth.ok) throw new Error(auth.error);
  if (!auth.apiKey) throw new Error(`No API key is available for ${options.model.provider}`);

  const prompt = buildEvaluationPrompt(options.goal, options.workerOutput, options.verification);
  const response = await complete(
    options.model,
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
    { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, reasoningEffort: "low" },
  );

  const raw = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  const result = parseEvaluation(raw);
  result.tokenUsage = extractUsage(response);
  return result;
}

// ─────────────────────────────────────
// Usage 提取 & 成本估算
// ─────────────────────────────────────

/** 从模型响应中提取 token usage（兼容多个 provider 命名） */
function extractUsage(response: any): EvaluationResult["tokenUsage"] {
  const usage = response?.usage ?? response?._rawUsage;
  if (!usage) return undefined;

  const inputTokens = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.cache_read ?? 0;
  const estimatedCost = estimateCost(inputTokens, outputTokens, cacheReadTokens);

  return { inputTokens, outputTokens, cacheReadTokens, estimatedCost };
}

/** Claude Sonnet 4 近似价格（可按实际模型调整） */
function estimateCost(inputTokens: number, outputTokens: number, cacheReadTokens: number): number {
  const inputPrice = 3.0 / 1_000_000;    // $3/MTok
  const outputPrice = 15.0 / 1_000_000;   // $15/MTok
  const cacheReadPrice = 0.3 / 1_000_000; // $0.3/MTok
  return inputTokens * inputPrice + outputTokens * outputPrice + cacheReadTokens * cacheReadPrice;
}

// ─────────────────────────────────────
// 评估 Prompt
// ─────────────────────────────────────

/** 构建独立评估 prompt（规则：严格基于证据，不接受标记代替证明） */
export function buildEvaluationPrompt(
  goal: GoalState,
  workerOutput: string,
  verification: VerificationResult,
): string {
  return `You are an independent completion evaluator. Decide only from the evidence below. Be strict: absence of proof means incomplete.\n\n` +
    `GOAL:\n${goal.condition}\n\n` +
    `DETERMINISTIC VERIFICATION:
${verification.command ?? "none configured"}\n` +
    `Result: ${verification.ok ? "PASS" : "FAIL"}\n${verification.output.slice(-8000)}\n\n` +
    `WORKER'S LATEST REPORT:\n${workerOutput.slice(-12000)}\n\n` +
    `Rules:\n` +
    `- complete=true only when the goal is fully satisfied and supported by concrete evidence.\n` +
    `- If a verifier command is configured and failed, complete must be false.\n` +
    `- blocked=true only when progress genuinely requires user input, permission, credentials, or an external state change.\n` +
    `- Do not accept plans, intentions, partial success, or a bare GOAL_COMPLETE marker as proof.\n` +
    `Return only JSON: {"complete":boolean,"blocked":boolean,"reason":"...","nextAction":"..."}`;
}
