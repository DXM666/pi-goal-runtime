// Pi Goal Runtime — 类型声明集中管理
// 所有跨模块使用的 interface / type 均在此定义

// ── 基础类型 ──

/** 目标状态 */
export type GoalStatus = "running" | "paused" | "blocked" | "achieved" | "failed";

/** 子 Agent 角色 — 对应 Claude Code 的三种专属 agent */
export type SubAgentRole = "explore" | "implement" | "verify";

/** 子 Agent 状态 */
export type SubAgentStatus = "pending" | "running" | "completed" | "failed";

// ── 结果类型 ──

/** 独立评估器的评估结果 */
export interface EvaluationResult {
  complete: boolean;
  blocked: boolean;
  reason: string;
  nextAction: string;
  raw?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    estimatedCost: number;
  };
}

/** 确定性校验命令的执行结果 */
export interface VerificationResult {
  ok: boolean;
  command?: string;
  exitCode?: number;
  output: string;
}

/// 归档的历史目标快照
export interface GoalResult {
  condition: string;
  status: GoalStatus;
  turns: number;
  totalTokensUsed: number;
  totalCostUsed: number;
  startedAt: number;
  endedAt: number;
  reason: string;
}

// ── 多 Agent 协作 ──

/** 子 Agent 任务 */
export interface SubAgentTask {
  id: string;
  role: SubAgentRole;
  description: string;
  dependsOn: string[];
  status: SubAgentStatus;
  output?: string;
  error?: string;
}

/** Scratchpad 共享知识条目 */
export interface ScratchpadEntry {
  from: string;
  content: string;
  timestamp: number;
}

/** 多 Agent 配置 */
export interface MultiAgentConfig {
  enabled: boolean;
  maxAgents: number;
  tasks: SubAgentTask[];
  scratchpad: ScratchpadEntry[];
  nextTaskId: string | null;
  allCompleted: boolean;
}

// ── 核心状态 ──

/** 完整的目标状态 */
export interface GoalState {
  version: 2;
  condition: string;
  verifyCommand?: string;
  status: GoalStatus;
  startedAt: number;
  updatedAt: number;
  turns: number;
  maxTurns: number;
  maxMinutes: number;
  maxNoProgress: number;
  noProgressTurns: number;
  lastProgressHash?: string;
  lastReason?: string;
  lastVerification?: VerificationResult;
  lastEvaluation?: EvaluationResult;
  evaluatorErrors: number;
  maxTokens?: number;
  maxCost?: number;
  totalTokensUsed: number;
  totalCostUsed: number;
  budgetLimited: boolean;
  compactOnOversize: boolean;
  /** 多 Agent 协作配置 */
  multiAgentConfig?: MultiAgentConfig;
  /** 已注册的 hooks */
  hooks: GoalHookEntry[];
  /** 历史完成的目标 */
  history: GoalResult[];
}

/** Hook 条目 */
import type { GoalHook, GoalHookEvent } from "./hooks.js";

export interface GoalHookEntry {
  event: GoalHookEvent;
  handler: GoalHook;
}
