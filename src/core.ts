// Pi Goal Runtime — 核心工具层
// 提供：类型导出、参数解析、提示词构建、校验执行、预算检查、Hook 触发

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

// ── 类型导入（集中在 types.ts 定义） ──
import type { GoalStatus, EvaluationResult, VerificationResult, GoalResult, GoalState } from "./types.js";
import type { GoalHookEntry } from "./types.js";
import type { GoalHookEvent, GoalHook, GoalHookContext } from "./hooks.js";
import { runHooks } from "./hooks.js";

// ── 类型重新导出（保持对外接口不变） ──
export type {
  GoalStatus,
  EvaluationResult,
  VerificationResult,
  GoalResult,
  GoalState,
  GoalHookEntry,
  GoalHookEvent,
  GoalHook,
  GoalHookContext,
};

// ─────────────────────────────────────
// 参数解析
// ─────────────────────────────────────

/**
 * 解析 /goal 命令的参数字符串
 * @example
 * parseGoalArgs("fix tests --verify npm test --max-turns 10 --max-tokens 50000")
 * // → { condition: "fix tests", verifyCommand: "npm test", maxTurns: 10, maxTokens: 50000, ... }
 */
export function parseGoalArgs(input: string): {
  condition: string;
  verifyCommand?: string;
  maxTurns: number;
  maxMinutes: number;
  maxNoProgress: number;
  maxTokens?: number;
  maxCost?: number;
  compactOnOversize: boolean;
  hooks?: Array<{ event: GoalHookEvent; handler: GoalHook }>;
} {
  // 以 " --" 分割参数（保留 condition 为第一段）
  const parts = input.split(/\s+--/);
  const condition = parts.shift()?.trim() ?? "";

  // 剩余部分以空格分割为 key-value 对
  const options = new Map<string, string>();
  for (const part of parts) {
    const [key, ...rest] = part.trim().split(/\s+/);
    options.set(key, rest.join(" ").trim());
  }

  return {
    condition,
    verifyCommand: options.get("verify") || undefined,
    maxTurns: positiveInt(options.get("max-turns"), 30),
    maxMinutes: positiveInt(options.get("max-minutes"), 240),
    maxNoProgress: positiveInt(options.get("max-no-progress"), 3),
    maxTokens: options.get("max-tokens") ? positiveInt(options.get("max-tokens"), 0) : undefined,
    maxCost: options.get("max-cost") ? positiveFloat(options.get("max-cost"), 0) : undefined,
    // --compact-on-oversize 可带值 "true" / "yes" 或直接作为 flag
    compactOnOversize: options.has("compact-on-oversize")
      && (options.get("compact-on-oversize") === "true"
        || options.get("compact-on-oversize") === "yes"
        || options.get("compact-on-oversize") === ""),
    hooks: [],
  };
}

/** 解析正整数，失败回退到默认值 */
function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 解析正浮点数，失败回退到默认值 */
function positiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ─────────────────────────────────────
// 提示词构建
// ─────────────────────────────────────

/**
 * 构建首轮 worker 提示词
 * 告知 agent 目标、完成标记协议和阻塞标记协议
 */
export function buildKickoff(state: GoalState): string {
  return `Work autonomously toward this persistent goal:

${state.condition}

` +
    `Definition of done: satisfy the condition and prove it with concrete evidence. ` +
    `Do actual work, use tools, and verify the result. When it is truly complete, end your response with ` +
    `GOAL_COMPLETE on its own line. Otherwise summarize progress, remaining work, and the next executable action. ` +
    `If progress requires user input or authority, end with GOAL_BLOCKED and explain exactly what is needed.`;
}

/**
 * 构建后续轮次 worker 提示词
 * 注入上一轮评估失败的原因和下一步行动建议
 */
export function buildContinuation(state: GoalState, reason: string): string {
  return `The persistent goal is not yet verified. Continue working; do not only describe what remains.

` +
    `GOAL:
${state.condition}

WHY THIS TURN MUST CONTINUE:
${reason}

` +
    `Run the most relevant checks after changing anything. Emit GOAL_COMPLETE on its own line only when the goal is ` +
    `satisfied and your response contains concrete verification evidence.`;
}

// ─────────────────────────────────────
// Markers 检测
// ─────────────────────────────────────

/** 检测 worker 输出中是否包含独立的 GOAL_COMPLETE 行 */
export function claimsCompletion(text: string): boolean {
  return /^GOAL_COMPLETE\s*$/m.test(text);
}

/** 检测 worker 输出中是否包含独立的 GOAL_BLOCKED 行 */
export function claimsBlocked(text: string): boolean {
  return /^GOAL_BLOCKED\s*$/m.test(text);
}

// ─────────────────────────────────────
// 评估回退
// ─────────────────────────────────────

/**
 * 评估器失败时的 fallback 判断
 * 仅基于 worker 输出的 GOAL_COMPLETE / GOAL_BLOCKED 标记
 */
export function defaultEvaluation(text: string): EvaluationResult {
  if (claimsBlocked(text)) {
    return {
      complete: false,
      blocked: true,
      reason: "The worker explicitly reported a blocker.",
      nextAction: "Request the missing input or authority.",
    };
  }
  return {
    complete: claimsCompletion(text),
    blocked: false,
    reason: claimsCompletion(text)
      ? "The worker supplied the completion marker."
      : "The worker did not claim completion.",
    nextAction: "Continue with the next concrete step and provide verification evidence.",
  };
}

// ─────────────────────────────────────
// 评估器响应解析
// ─────────────────────────────────────

/**
 * 解析评估器返回的 JSON 结果
 * 严格验证字段类型无效时抛出异常
 */
export function parseEvaluation(raw: string): EvaluationResult {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Evaluator returned no JSON object");

  const value = JSON.parse(match[0]) as Partial<EvaluationResult>;
  if (
    typeof value.complete !== "boolean"
    || typeof value.blocked !== "boolean"
    || typeof value.reason !== "string"
  ) {
    throw new Error("Evaluator returned an invalid verdict");
  }

  return {
    complete: value.complete,
    blocked: value.blocked,
    reason: value.reason.slice(0, 4000),
    nextAction: typeof value.nextAction === "string"
      ? value.nextAction.slice(0, 4000)
      : "Continue working toward the goal.",
    raw,
  };
}

// ─────────────────────────────────────
// 进度检测
// ─────────────────────────────────────

/**
 * 计算进度哈希（worker 输出 + 校验结果）
 * 用于检测连续轮次是否有实质进展变化
 */
export function progressHash(text: string, verification: VerificationResult): string {
  return createHash("sha256")
    .update(text.replace(/\s+/g, " ").trim())
    .update("\0")
    .update(String(verification.exitCode ?? "none"))
    .update("\0")
    .update(verification.output.slice(-4000))
    .digest("hex");
}

// ─────────────────────────────────────
// 预算 & 限制检查
// ─────────────────────────────────────

/** 检查是否超过时间限制 */
export function timeLimitExceeded(state: GoalState, now = Date.now()): boolean {
  return now - state.startedAt >= state.maxMinutes * 60_000;
}

/** 检查是否超过 token 或 cost 预算 */
export function tokenBudgetExceeded(state: GoalState): boolean {
  if (state.maxTokens && state.totalTokensUsed >= state.maxTokens) return true;
  if (state.maxCost && state.totalCostUsed >= state.maxCost) return true;
  return false;
}

// ─────────────────────────────────────
// 确定性校验执行
// ─────────────────────────────────────

/**
 * 在子进程中执行校验命令
 * 合并 stdout/stderr，截断至 20KB 避免内存溢出
 */
export async function runVerification(
  command: string | undefined,
  cwd: string,
): Promise<VerificationResult> {
  if (!command) return { ok: true, output: "No deterministic verifier configured." };

  return await new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env });
    let output = "";

    const append = (chunk: unknown) => {
      output += String(chunk);
      if (output.length > 20_000) output = output.slice(-20_000);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => resolve({ ok: false, command, output: error.message }));
    child.on("close", (code) => resolve({
      ok: code === 0,
      command,
      exitCode: code ?? undefined,
      output: output.trim() || `(command exited ${code})`,
    }));
  });
}

// ─────────────────────────────────────
// Hook 触发
// ─────────────────────────────────────

/**
 * 触发当前目标上注册的指定事件 hooks
 * 仅 pre-turn hook 可以 block；其他事件 hook 仅做通知
 */
export async function runGoalHooks(
  state: GoalState,
  event: GoalHookEvent,
  ctx: Omit<GoalHookContext, "goal" | "turn"> = {},
): Promise<{ block: boolean; reason?: string }> {
  return runHooks(state.hooks ?? [], event, { ...ctx, goal: state, turn: state.turns });
}

// ─────────────────────────────────────
// 历史快照
// ─────────────────────────────────────

/**
 * 为目标创建 history 归档快照
 * 在目标状态变为 paused/blocked/achieved 时调用
 */
export function createGoalResult(state: GoalState, endedAt: number): GoalResult {
  return {
    condition: state.condition,
    status: state.status,
    turns: state.turns,
    totalTokensUsed: state.totalTokensUsed,
    totalCostUsed: state.totalCostUsed,
    startedAt: state.startedAt,
    endedAt,
    reason: state.lastReason ?? "",
  };
}


// ─────────────────────────────────────
// 参数解析辅助函数（供 goal.ts 内部使用）
// ─────────────────────────────────────

/** 解析正整数 flag，失败回退默认值 */
export function parsePositiveFlag(value: boolean | string | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 可选正整数参数 */
export function parseOptionalPositive(value: boolean | string | undefined): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 可选正浮点数参数 */
export function parseOptionalPositiveFloat(value: boolean | string | undefined): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 人类可读 token 数（1.2k / 1.5M） */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}


// ─────────────────────────────────────
// 消息解析辅助函数
// ─────────────────────────────────────

/** 从 agent messages 中提取纯文本内容 */
export function extractText(messages: unknown): string {
  if (!Array.isArray(messages)) return JSON.stringify(messages ?? "");
  return messages.map((message) => {
    const msgContent = (message as { content?: unknown }).content;
    if (typeof msgContent === "string") return msgContent;
    if (!Array.isArray(msgContent)) return "";
    return msgContent.map((part) => {
      if (typeof part === "string") return part;
      return (part as { text?: string }).text ?? "";
    }).join("\n");
  }).join("\n");
}

/** 从 agent messages 中提取累计 token usage */
export function extractTokenUsage(messages: unknown): {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; estimatedCost: number;
} {
  if (!Array.isArray(messages)) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCost: 0 };
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let estimatedCost = 0;
  for (const msg of messages) {
    const usage = (msg as { usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } }).usage;
    if (usage) {
      inputTokens += usage.input ?? 0;
      outputTokens += usage.output ?? 0;
      cacheReadTokens += usage.cacheRead ?? 0;
      estimatedCost += usage.cost?.total ?? 0;
    }
  }
  return { inputTokens, outputTokens, cacheReadTokens, estimatedCost };
}


// ─────────────────────────────────────
// 状态格式化 & 历史归档
// ─────────────────────────────────────

/** 格式化目标状态供用户查看 */
export function formatStatus(goal: GoalState | undefined): string {
  if (!goal) return "No goal exists in this session.";
  const verify = goal.verifyCommand ?? "agent evidence only";
  const budget = goal.maxTokens
    ? `\nToken budget: ${formatTokens(goal.totalTokensUsed)}/${formatTokens(goal.maxTokens)}`
    : "";
  const cost = goal.maxCost
    ? `\nCost budget: $${goal.totalCostUsed.toFixed(4)}/$${goal.maxCost.toFixed(4)}`
    : "";
  const history = goal.history?.length
    ? `\nHistory: ${goal.history.length} completed goal(s)`
    : "";
  return `${goal.status.toUpperCase()} - ${goal.condition}\nTurns: ${goal.turns}/${goal.maxTurns}\nVerifier: ${verify}${budget}${cost}${history}`
    + (goal.lastReason ? `\nLast result: ${goal.lastReason}` : "");
}

/** 将当前状态归档到 history，返回新的不可变 GoalState */
export function archiveGoalToHistory(state: GoalState, endedAt: number): GoalState {
  const result = createGoalResult(state, endedAt);
  return { ...state, history: [...(state.history ?? []), result] };
}

/** 阻塞指定毫秒（用于退避重试） */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// ═══════════════════════════════════════════════════════════
// 多 Agent 协作 (Multi-Agent Coordinator)
// ═══════════════════════════════════════════════════════════

/** 子 Agent 角色 — 对应 Claude Code 的三种专属 agent */
export type SubAgentRole = "explore" | "implement" | "verify";

/** 子 Agent 执行状态 */
export type SubAgentStatus = "pending" | "running" | "completed" | "failed";

/** 子 Agent 任务描述 */
export interface SubAgentTask {
  /** 唯一标识 */
  id: string;
  /** 角色 */
  role: SubAgentRole;
  /** 该子 agent 负责的具体描述 */
  description: string;
  /** 依赖的其他子任务 id（有依赖则等依赖完成后才启动） */
  dependsOn: string[];
  /** 当前状态 */
  status: SubAgentStatus;
  /** 创建时的输出摘要 */
  output?: string;
  /** 失败原因 */
  error?: string;
}

/** Scratchpad 条目 — 子 Agent 之间的共享知识 */
export interface ScratchpadEntry {
  /** 来源子 Agent id */
  from: string;
  /** 内容 */
  content: string;
  /** 时间戳 */
  timestamp: number;
}

/** 多 Agent 配置 */
export interface MultiAgentConfig {
  /** 是否启用多 Agent 模式 */
  enabled: boolean;
  /** 最大并发子 Agent 数 */
  maxAgents: number;
  /** 子 Agent 任务列表 */
  tasks: SubAgentTask[];
  /** 共享 Scratchpad */
  scratchpad: ScratchpadEntry[];
  /** 下一个要分配的 task id */
  nextTaskId: string | null;
  /** 是否全部子任务已完成 */
  allCompleted: boolean;
}

/** 默认多 Agent 配置 */
export function createDefaultMultiagentConfig(): MultiAgentConfig {
  return {
    enabled: false,
    maxAgents: 3,
    tasks: [],
    scratchpad: [],
    nextTaskId: null,
    allCompleted: false,
  };
}

/**
 * 使用 prompt 分析目标并拆分子任务
 * 注：实际的拆分在 evaluator 扩展中完成（由 LLM 分析）
 * 这里提供占位结构
 */

/** 子 Agent 提示词：Explore（只读探索） */
export function buildExplorePrompt(taskDescription: string, scratchpad: ScratchpadEntry[]): string {
  const context = scratchpad.map((e) => `[${e.from}] ${e.content}`).join("\n");
  return `You are an EXPLORE agent. Your job is read-only research.\n\n` +
    `## Your Task\n${taskDescription}\n\n` +
    `## Context from Other Agents\n${context || "(none yet)"}\n\n` +
    `## Rules\n` +
    `- DO NOT modify any files. Research only.\n` +
    `- Report findings clearly with file paths and line numbers.\n` +
    `- End your response with SUB_AGENT_COMPLETE on its own line.\n` +
    `- If blocked, end with SUB_AGENT_BLOCKED and explain why.`;
}

/** 子 Agent 提示词：Implement（编码实现） */
export function buildImplementPrompt(taskDescription: string, scratchpad: ScratchpadEntry[]): string {
  const context = scratchpad.map((e) => `[${e.from}] ${e.content}`).join("\n");
  return `You are an IMPLEMENT agent. Your job is to write/modify code.\n\n` +
    `## Your Task\n${taskDescription}\n\n` +
    `## Context from Other Agents\n${context || "(none yet)"}\n\n` +
    `## Rules\n` +
    `- Make actual code changes. Do not stop at planning.\n` +
    `- Verify your changes compile/work after editing.\n` +
    `- End your response with SUB_AGENT_COMPLETE on its own line.\n` +
    `- If blocked, end with SUB_AGENT_BLOCKED and explain what you need.`;
}

/** 子 Agent 提示词：Verify（验证测试） */
export function buildVerifyPrompt(taskDescription: string, scratchpad: ScratchpadEntry[]): string {
  const context = scratchpad.map((e) => `[${e.from}] ${e.content}`).join("\n");
  return `You are a VERIFY agent. Your job is to validate and test.\n\n` +
    `## Your Task\n${taskDescription}\n\n` +
    `## Context from Other Agents\n${context || "(none yet)"}\n\n` +
    `## Rules\n` +
    `- Run tests, check for bugs, verify correctness.\n` +
    `- Report pass/fail with evidence.\n` +
    `- End your response with SUB_AGENT_COMPLETE on its own line.\n` +
    `- If blocked, end with SUB_AGENT_BLOCKED and explain why.`;
}

/** 根据角色构建子 Agent 提示词 */
export function buildSubAgentPrompt(
  role: SubAgentRole,
  taskDescription: string,
  scratchpad: ScratchpadEntry[],
): string {
  switch (role) {
    case "explore": return buildExplorePrompt(taskDescription, scratchpad);
    case "implement": return buildImplementPrompt(taskDescription, scratchpad);
    case "verify": return buildVerifyPrompt(taskDescription, scratchpad);
  }
}

/** 检测子 Agent 完成标记 */
export function claimsSubAgentComplete(text: string): boolean {
  return /^SUB_AGENT_COMPLETE\s*$/m.test(text);
}

/** 检测子 Agent 阻塞标记 */
export function claimsSubAgentBlocked(text: string): boolean {
  return /^SUB_AGENT_BLOCKED\s*$/m.test(text);
}

/** 初始化多 Agent 任务列表 */
export function initMultiAgentTasks(
  goalCondition: string,
  subTaskDescriptions: { role: SubAgentRole; description: string; dependsOn?: string[] }[],
): SubAgentTask[] {
  return subTaskDescriptions.map((t, i) => ({
    id: `sub-${i + 1}`,
    role: t.role,
    description: t.description,
    dependsOn: t.dependsOn ?? [],
    status: "pending" as const,
  }));
}
