// Pi Goal Runtime — Hook 事件系统
// 提供类型安全的生命周期钩子，错误隔离（单 hook 异常不中断循环）

import type { GoalState, VerificationResult, EvaluationResult } from "./types.js";

// ─────────────────────────────────────
// 事件类型
// ─────────────────────────────────────

/** 所有可用的 Hook 事件 */
export type GoalHookEvent =
  | "pre-turn"           // 校验/评估运行前（可 block）
  | "post-turn"          // 评估完成后（仅通知）
  | "on-blocked"         // worker 报告阻塞时
  | "on-achieved"        // 目标达成时
  | "on-paused"          // 目标暂停时（任何原因）
  | "on-budget-limited"  // 预算耗尽时
  | "on-compact";        // 上下文压缩时

// ─────────────────────────────────────
// Hook 上下文
// ─────────────────────────────────────

/**
 * Hook 处理函数的入参
 * 提供当前 goals 状态、轮次和可选的评估结果
 */
export interface GoalHookContext {
  /** 当前目标状态 */
  goal: GoalState;
  /** 当前轮次数 */
  turn: number;
  /** 原因（可选） */
  reason?: string;
  /** 校验结果（仅 post-turn / on-blocked） */
  verification?: VerificationResult;
  /** 评估结果（仅 post-turn） */
  evaluation?: EvaluationResult;
  /** Token 消耗信息 */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    estimatedCost: number;
  };
}

// ─────────────────────────────────────
// Hook 返回值
// ─────────────────────────────────────

/** Hook 函数返回值 — block=true 可阻止下一轮继续 */
export type GoalHookResult = {
  /** 是否阻止继续 */
  block?: boolean;
  /** 阻止原因 */
  reason?: string;
};

/** Hook 处理函数签名 */
export type GoalHook = (
  ctx: GoalHookContext,
) => GoalHookResult | void | Promise<GoalHookResult | void>;

// ─────────────────────────────────────
// Hook 执行器
// ─────────────────────────────────────

/**
 * 执行指定事件的所有已注册 hooks
 * - 按注册顺序串行执行
 * - 第一个返回 block=true 的 hook 会阻止后续 hook
 * - 单个 hook 抛错被捕获并日志，不影响其他 hook
 */
export async function runHooks(
  hooks: Array<{ event: GoalHookEvent; handler: GoalHook }>,
  event: GoalHookEvent,
  ctx: GoalHookContext,
): Promise<{ block: boolean; reason?: string }> {
  const matching = hooks.filter((h) => h.event === event);
  for (const hook of matching) {
    try {
      const result = await hook.handler(ctx);
      if (result?.block) {
        return { block: true, reason: result.reason || `Hook blocked: ${event}` };
      }
    } catch (error) {
      // Hook 异常不应中断循环 — 仅日志记录
      console.error(`[pi-goal-runtime] Hook error on "${event}":`, error);
    }
  }
  return { block: false };
}
