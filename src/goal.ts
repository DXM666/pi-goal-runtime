/**
 * Pi Goal Runtime — 扩展主入口
 *
 * 职责：
 * 1. 注册 Pi 命令（/goal, /goal-resume, /goal-status, /goal-hook）
 * 2. 注册 CLI flags（headless 模式使用）
 * 3. 监听 Pi 生命周期事件 → 编排 agent_settled 循环
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 类型 ──
import type { GoalState, GoalResult, MultiAgentConfig, SubAgentTask } from "./types.js";

// ── 核心工具 ──
import {
  archiveGoalToHistory,
  buildContinuation,
  buildKickoff,
  createGoalResult,
  defaultEvaluation,
  extractText,
  extractTokenUsage,
  formatStatus,
  formatTokens,
  parseGoalArgs,
  parseOptionalPositive,
  parseOptionalPositiveFloat,
  parsePositiveFlag,
  progressHash,
  runGoalHooks,
  createDefaultMultiagentConfig,
  buildSubAgentPrompt,
  claimsSubAgentComplete,
  claimsSubAgentBlocked,
  initMultiAgentTasks,
  runVerification,
  sleep,
  timeLimitExceeded,
} from "./core.js";

// ── 评估器 ──
import { evaluateGoal } from "./evaluator.js";

// ── 常量 ──
const ENTRY_TYPE = "pi-goal-runtime";
const MAX_EVALUATOR_RETRIES = 3;
const EVALUATOR_RETRY_DELAYS = [1000, 2000, 4000]; // 指数退避重试延迟

/**
 * 扩展工厂函数 — 由 Pi 加载时调用
 * 通过 pi 参数注册命令、flags 和事件监听器
 */
export default function goalExtension(pi: ExtensionAPI) {
  // ── 模块状态 ──
  let goal: GoalState | undefined;
  let continuing = false;           // 防止 agent_settled 重入
  let lastAgentText = "";           // 当前轮 worker 输出
  let lastTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCost: 0 };
  let ui: { setStatus(key: string, text: string | undefined): void } | undefined;

  // ── 内部函数 ──

  /**
   * 持久化当前状态到 session JSONL 条目 + 更新状态栏
   */
  const persist = () => {
    if (goal) pi.appendEntry(ENTRY_TYPE, goal);
    updateStatus();
  };

  /**
   * 更新 Pi 状态栏显示当前进度
   * 格式: "goal 3/30 (45.2k/100.0k tok)"
   */
  const updateStatus = () => {
    if (!goal || goal.status !== "running") {
      ui?.setStatus("goal", undefined);
      return;
    }
    const budget = goal.maxTokens
      ? ` (${formatTokens(goal.totalTokensUsed)}/${formatTokens(goal.maxTokens)} tok)`
      : "";
    ui?.setStatus("goal", `goal ${goal.turns}/${goal.maxTurns}${budget}`);
  };

  // ── 注册 CLI Flags（headless / CI 模式使用） ──
  pi.registerFlag("goal-condition", {
    description: "Run a headless prompt under a persistent completion condition",
    type: "string",
  });
  pi.registerFlag("goal-max-turns", { description: "Headless goal turn limit", type: "string", default: "30" });
  pi.registerFlag("goal-max-minutes", { description: "Headless goal time limit", type: "string", default: "240" });
  pi.registerFlag("goal-max-tokens", { description: "Headless goal token budget", type: "string" });
  pi.registerFlag("goal-max-cost", { description: "Headless goal cost budget (USD)", type: "string" });
  pi.registerFlag("goal-max-agents", { description: "Max parallel sub-agents (multi-agent mode)", type: "string", default: "3" });

  /**
   * before_agent_start 事件
   * 仅 headless 模式（--goal-condition）：创建初始 GoalState
   */
  pi.on("before_agent_start", (_event, ctx) => {
    ui = ctx.ui;
    const condition = pi.getFlag("goal-condition");
    if (goal || typeof condition !== "string" || !condition.trim()) return;
    const now = Date.now();
    goal = {
      version: 2,
      condition: condition.trim(),
      status: "running",
      startedAt: now,
      updatedAt: now,
      turns: 0,
      maxTurns: parsePositiveFlag(pi.getFlag("goal-max-turns"), 30),
      maxMinutes: parsePositiveFlag(pi.getFlag("goal-max-minutes"), 240),
      maxNoProgress: 3,
      noProgressTurns: 0,
      evaluatorErrors: 0,
      maxTokens: parseOptionalPositive(pi.getFlag("goal-max-tokens")),
      maxCost: parseOptionalPositiveFloat(pi.getFlag("goal-max-cost")),
      totalTokensUsed: 0,
      totalCostUsed: 0,
      budgetLimited: false,
      compactOnOversize: false,
      hooks: [],
      history: [],
    };
    persist();
    return {
      message: {
        customType: ENTRY_TYPE,
        content: buildKickoff(goal),
        display: true,
        details: { turn: 0, headless: true },
      },
    };
  });

  /**
   * session_start 事件
   * 从 session JSONL 恢复持久化的目标状态
   */
  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.ui;
    goal = undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        const restored = entry.data as Partial<GoalState>;
        goal = {
          ...restored,
          version: 2,
          evaluatorErrors: restored.evaluatorErrors ?? 0,
          totalTokensUsed: restored.totalTokensUsed ?? 0,
          totalCostUsed: restored.totalCostUsed ?? 0,
          budgetLimited: restored.budgetLimited ?? false,
          compactOnOversize: restored.compactOnOversize ?? false,
          hooks: restored.hooks ?? [],
          history: restored.history ?? [],
        } as GoalState;
      }
    }
    updateStatus();
    if (goal?.status === "running") {
      ctx.ui.notify("Restored an active goal. It will continue after the next agent turn; use /goal-resume to start now.", "info");
    }
  });

  /**
   * session_shutdown 事件 — 清理状态
   */
  pi.on("session_shutdown", () => {
    continuing = false;
    ui?.setStatus("goal", undefined);
    ui = undefined;
  });

  /**
   * agent_end 事件
   * 捕获 worker 输出文本和 token usage
   */
  pi.on("agent_end", (event) => {
    lastAgentText = extractText(event.messages);
    lastTokenUsage = extractTokenUsage(event.messages);
  });

  // ── 注册命令 ──
  /**
   * /goal <condition> [options]
   * 创建新目标 / 查看状态 / 暂停 / 查看历史
   */
  pi.registerCommand("goal", {
    description: "Run until a verifiable condition holds. Options: --verify CMD --max-turns N --max-minutes N --max-tokens N --max-cost N --compact-on-oversize",
    handler: async (args, ctx) => {
      ui = ctx.ui;
      const trimmed = args.trim();

      // 无参数 → 仅查看状态
      if (!trimmed) {
        ctx.ui.notify(formatStatus(goal), "info");
        return;
      }

      const lower = trimmed.toLowerCase();

      // 暂停 / 取消
      if (["clear", "stop", "cancel", "pause"].includes(lower)) {
        if (goal) {
          const endedAt = Date.now();
          goal = archiveGoalToHistory(goal, endedAt);
          goal = { ...goal, status: "paused", updatedAt: endedAt, lastReason: "Paused by user" };
          persist();
        }
        ctx.ui.notify("Goal paused.", "info");
        return;
      }

      // 查看历史
      if (lower === "history") {
        if (!goal || !goal.history?.length) {
          ctx.ui.notify("No goal history in this session.", "info");
          return;
        }
        const h = goal.history;
        const historyLines = h.map((r, i) => {
          const emoji = r.status === "achieved" ? "[OK]" : r.status === "blocked" ? "[BLK]" : "[---]";
          return `${i + 1}. ${emoji} ${r.condition} | ${r.turns} turns | ${formatTokens(r.totalTokensUsed)} tok | $${r.totalCostUsed.toFixed(4)}`;
        });
        ctx.ui.notify(`Goal history (${h.length}):\n${historyLines.join("\n")}`, "info");
        return;
      }

      // 清除历史
      if (lower === "clear-history") {
        if (goal) {
          goal = { ...goal, history: [] };
          persist();
        }
        ctx.ui.notify("Goal history cleared.", "info");
        return;
      }

      // 解析参数并创建新目标
      const options = parseGoalArgs(trimmed);
      if (!options.condition) {
        ctx.ui.notify("Usage: /goal <condition> [--verify <command>] [--max-turns N] [--max-minutes N] [--max-tokens N] [--max-cost N] [--compact-on-oversize]", "error");
        return;
      }

      const now = Date.now();
      goal = {
        version: 2,
        condition: options.condition,
        verifyCommand: options.verifyCommand,
        status: "running",
        startedAt: now,
        updatedAt: now,
        turns: 0,
        maxTurns: options.maxTurns,
        maxMinutes: options.maxMinutes,
        maxNoProgress: options.maxNoProgress,
        noProgressTurns: 0,
        evaluatorErrors: 0,
        maxTokens: options.maxTokens,
        maxCost: options.maxCost,
        totalTokensUsed: 0,
        totalCostUsed: 0,
        budgetLimited: false,
        compactOnOversize: options.compactOnOversize,
        hooks: [],
        history: goal?.history ?? [], // 保留当前 session 的历史
      };
      persist();
      pi.setSessionName(`Goal: ${options.condition.slice(0, 60)}`);
      pi.sendMessage({
        customType: ENTRY_TYPE,
        content: buildKickoff(goal),
        display: true,
        details: { turn: 0, kickoff: true },
      }, { triggerTurn: true, deliverAs: "followUp" });
    },
  });

  /**
   * /goal-resume — 恢复暂停的目标
   */
  pi.registerCommand("goal-resume", {
    description: "Resume the persisted goal in this session",
    handler: async (_args, ctx) => {
      ui = ctx.ui;
      if (!goal) {
        ctx.ui.notify("No goal exists in this session.", "error");
        return;
      }
      goal = { ...goal, status: "running", updatedAt: Date.now(), lastReason: "Resumed by user" };
      persist();
      pi.sendMessage({
        customType: ENTRY_TYPE,
        content: buildContinuation(goal, "The user resumed this goal."),
        display: true,
        details: { turn: goal.turns, resumed: true },
      }, { triggerTurn: true, deliverAs: "followUp" });
    },
  });

  /**
   * /goal-status — 显示详细状态
   */
  pi.registerCommand("goal-status", {
    description: "Show persistent goal status",
    handler: async (_args, ctx) => {
      ui = ctx.ui;
      ctx.ui.notify(formatStatus(goal), "info");
    },
  });

  /**
   * /goal-hook [event] — 查看已注册的 hooks
   */

  /**
   * agent_settled 事件 — 目标循环的核心
   *
   * 每个 worker 轮次完成后执行：
   * 1. 累计 token/cost usage
   * 2. 预算检查
   * 3. 上下文压缩（可选）
   * 4. pre-turn hook（可阻止继续）
   * 5. 确定性校验命令
   * 6. 独立模型评估（带指数退避）
   * 7. post-turn hook
   * 8. 综合判定 → achieved / blocked / paused / 继续
   */
  
  /**
   * /goal-decompose — 分析目标并拆分子任务（仅预览，不执行）
   */
  pi.registerCommand("goal-decompose", {
    description: "Analyze goal and preview sub-task decomposition",
    handler: async (args, ctx) => {
      ui = ctx.ui;
      const g = goal;
      if (!g) {
        ctx.ui.notify("No active goal.", "error");
        return;
      }
      const goalText = args.trim() || g.condition;
      const subTasks = decomposeGoal(goalText);
      const lines = subTasks.map((t, i) => `${i + 1}. [${t.role}] ${t.description}`);
      ctx.ui.notify(
        `Sub-tasks for: ${goalText}

${lines.join("\n")}

Use /goal "${goalText}" --multi-agent to execute with sub-agents.`,
        "info"
      );
    },
  });

  /**
   * /goal-subagents — 查看子 Agent 执行状态
   */
  pi.registerCommand("goal-subagents", {
    description: "Show sub-agent execution status",
    handler: async (_args, ctx) => {
      ui = ctx.ui;
      const g = goal;
      if (!g?.multiAgentConfig?.enabled) {
        ctx.ui.notify("Multi-agent mode not enabled for this goal.", "info");
        return;
      }
      const mac = g.multiAgentConfig;
      const statusIcons: Record<string, string> = {
        pending: "[--]",
        running: "[RUN]",
        completed: "[OK]",
        failed: "[ERR]",
      };
      const lines = mac.tasks.map(t => `${statusIcons[t.status] || "[?]"} ${t.id} (${t.role}): ${t.description}`);
      const scratchpadInfo = mac.scratchpad.length ? `
Scratchpad: ${mac.scratchpad.length} entries` : "";
      ctx.ui.notify(
        `Sub-agents (${mac.tasks.filter(t => t.status === "completed").length}/${mac.tasks.length} complete):
${lines.join("\n")}${scratchpadInfo}`,
        "info"
      );
    },
  });

  /**
   * /goal-multi-agent — 启用多 Agent 模式并启动
   */
  pi.registerCommand("goal-multi-agent", {
    description: "Enable multi-agent mode for current goal: /goal-multi-agent [task1; task2; ...]",
    handler: async (args, ctx) => {
      ui = ctx.ui;
      const g = goal;
      if (!g) {
        ctx.ui.notify("No active goal. Start one with /goal <condition> first.", "error");
        return;
      }
      const subTaskArgs = args.trim();
      const subTasks = subTaskArgs ? subTaskArgs.split(/[;；\n]+/).map(s => s.trim()).filter(Boolean) : null;
      if (!subTasks || subTasks.length < 2) {
        ctx.ui.notify("Provide at least 2 sub-tasks separated by semicolons.", "error");
        return;
      }

      const tasks: SubAgentTask[] = subTasks.map((desc, i) => ({
        id: `sub-${i + 1}`,
        role: i === 0 ? "explore" : i === subTasks.length - 1 ? "verify" : "implement",
        description: desc,
        dependsOn: i > 0 ? [`sub-${i}`] : [],
        status: "pending" as const,
      }));

      const firstTask = tasks[0];
      firstTask.status = "running";

      goal = {
        ...g,
        multiAgentConfig: {
          enabled: true,
          maxAgents: tasks.length,
          tasks,
          scratchpad: [],
          nextTaskId: firstTask.id,
          allCompleted: false,
        },
        updatedAt: Date.now(),
      };
      persist();

      const prompt = buildSubAgentPrompt(firstTask.role, firstTask.description, []);
      pi.sendMessage({
        customType: ENTRY_TYPE,
        content: prompt,
        display: true,
        details: { turn: g.turns, subAgent: firstTask.id, multiAgent: true },
      }, { triggerTurn: true, deliverAs: "followUp" });
    },
  });

pi.on("agent_settled", async (_event, ctx) => {
    ui = ctx.ui;
    // 基本守护条件
    if (!goal || goal.status !== "running" || continuing || !ctx.isIdle()) return;
    continuing = true;

    try {
      const text = lastAgentText;

      // ── 1. 累计 worker 轮次的 token usage ──
      const workerTokens = lastTokenUsage.inputTokens + lastTokenUsage.outputTokens + lastTokenUsage.cacheReadTokens;
      const workerCost = lastTokenUsage.estimatedCost;
      const accruedTokens = goal.totalTokensUsed + workerTokens;
      const accruedCost = goal.totalCostUsed + workerCost;

      // ── 2. 预算检查（验证前退出，节省成本） ──
      if ((goal.maxTokens && accruedTokens >= goal.maxTokens) ||
          (goal.maxCost && accruedCost >= goal.maxCost)) {
        const reason = `Budget limited: ${formatTokens(accruedTokens)} tokens, $${accruedCost.toFixed(4)} spent.`;
        goal = archiveGoalToHistory({ ...goal, status: "paused" as const, budgetLimited: true, updatedAt: Date.now(), lastReason: reason }, Date.now());
        persist();
        await runGoalHooks(goal, "on-budget-limited");
        ctx.ui.notify(`Goal paused: ${reason}`, "warning");
        return;
      }

      // ── 3. 上下文压缩（可选） ──
      if (goal.compactOnOversize) {
        const usage = ctx.getContextUsage();
        if (usage?.percent && usage.percent > 80) {
          ctx.compact({ customInstructions: `Goal: ${goal.condition}. Preserve all progress and next actions.` });
          await runGoalHooks(goal, "on-compact");
        }
      }

      // ── 4. pre-turn hook（可阻止继续） ──
      const preHookResult = await runGoalHooks(goal, "pre-turn", { tokenUsage: lastTokenUsage });
      if (preHookResult.block) {
        const reason = `Blocked by pre-turn hook: ${preHookResult.reason}`;
        goal = archiveGoalToHistory({ ...goal, status: "paused" as const, updatedAt: Date.now(), lastReason: reason }, Date.now());
        persist();
        ctx.ui.notify(`Goal paused: ${reason}`, "warning");
        return;
      }

      // ── 5. 执行确定性校验 ──
      const verification = await runVerification(goal.verifyCommand, ctx.cwd);

      // ── 6. 独立评估（带指数退避重试） ──
      let evaluation: Awaited<ReturnType<typeof evaluateGoal>> | ReturnType<typeof defaultEvaluation>;
      let evaluatorAttempt = 0;
      let evalTokens = 0;
      let evalCost = 0;

      while (true) {
        try {
          evaluation = await evaluateGoal({
            goal,
            workerOutput: text,
            verification,
            model: ctx.model,
            modelRegistry: ctx.modelRegistry,
          });
          // 成功后重置失败计数
          goal = { ...goal, evaluatorErrors: 0 };
          if (evaluation.tokenUsage) {
            evalTokens = evaluation.tokenUsage.inputTokens + evaluation.tokenUsage.outputTokens + evaluation.tokenUsage.cacheReadTokens;
            evalCost = evaluation.tokenUsage.estimatedCost;
          }
          break;
        } catch (error) {
          evaluatorAttempt++;
          evaluation = defaultEvaluation(text);
          evaluation.reason = `Independent evaluator failed (attempt ${evaluatorAttempt}): ${error instanceof Error ? error.message : String(error)}. ${evaluation.reason}`;
          goal = { ...goal, evaluatorErrors: (goal.evaluatorErrors ?? 0) + 1 };
          if (evaluatorAttempt >= MAX_EVALUATOR_RETRIES || goal.evaluatorErrors >= MAX_EVALUATOR_RETRIES) break;
          await sleep(EVALUATOR_RETRY_DELAYS[evaluatorAttempt - 1] ?? 4000);
        }
      }

      // ── 累计总消耗（worker + evaluator） ──
      const totalTokens = accruedTokens + evalTokens;
      const totalCost = accruedCost + evalCost;
      const hash = progressHash(text, verification);
      const noProgressTurns = hash === goal.lastProgressHash ? goal.noProgressTurns + 1 : 0;
      const turns = goal.turns + 1;

      // ── 7. post-turn hook ──
      await runGoalHooks(goal, "post-turn", { verification, evaluation, tokenUsage: lastTokenUsage });

      // ── 8. 判定 ──

      // 构建下一状态（不可变更新）
      const next: GoalState = {
        ...goal,
        turns,
        noProgressTurns,
        totalTokensUsed: totalTokens,
        totalCostUsed: totalCost,
        lastProgressHash: hash,
        lastVerification: verification,
        lastEvaluation: evaluation,
        updatedAt: Date.now(),
      };

      // ── 达成 ──
      if (evaluation.complete && verification.ok) {
        goal = archiveGoalToHistory({ ...next, status: "achieved", lastReason: evaluation.reason }, Date.now());
        persist();
        await runGoalHooks(goal, "on-achieved", { evaluation });
        ctx.ui.notify(`Goal achieved after ${turns} turns.`, "info");
        return;
      }

      // ── 阻塞 ──
      if (evaluation.blocked) {
        goal = archiveGoalToHistory({ ...next, status: "blocked", lastReason: evaluation.reason }, Date.now());
        persist();
        await runGoalHooks(goal, "on-blocked", { evaluation });
        ctx.ui.notify(`Goal blocked: ${evaluation.reason}`, "warning");
        return;
      }

      // ── 评估器连续失败 ──
      if (goal.evaluatorErrors >= MAX_EVALUATOR_RETRIES) {
        const reason = "Independent evaluator failed three consecutive times.";
        goal = archiveGoalToHistory({ ...next, status: "paused", lastReason: reason }, Date.now());
        persist();
        await runGoalHooks(goal, "on-paused", { reason });
        ctx.ui.notify(`Goal paused: ${reason}`, "warning");
        return;
      }

      // ── 轮次/时间限制 ──
      if (turns >= goal.maxTurns || timeLimitExceeded(next)) {
        const reason = turns >= goal.maxTurns ? "Maximum turn budget reached." : "Maximum time budget reached.";
        goal = archiveGoalToHistory({ ...next, status: "paused", lastReason: reason }, Date.now());
        persist();
        await runGoalHooks(goal, "on-paused", { reason });
        ctx.ui.notify(`Goal paused: ${reason}`, "warning");
        return;
      }

      // ── 预算限制（evaluator 调用后检查） ──
      if ((goal.maxTokens && totalTokens >= goal.maxTokens) || (goal.maxCost && totalCost >= goal.maxCost)) {
        const reason = `Budget limited: ${formatTokens(totalTokens)} tokens, $${totalCost.toFixed(4)} spent.`;
        goal = archiveGoalToHistory({ ...next, status: "paused", budgetLimited: true, lastReason: reason }, Date.now());
        persist();
        await runGoalHooks(goal, "on-budget-limited");
        ctx.ui.notify(`Goal paused: ${reason}`, "warning");
        return;
      }

      // ── 无实质进展 ──
      if (noProgressTurns >= goal.maxNoProgress) {
        const reason = `No observable progress for ${noProgressTurns} consecutive turns.`;
        goal = archiveGoalToHistory({ ...next, status: "paused", lastReason: reason }, Date.now());
        persist();
        await runGoalHooks(goal, "on-paused", { reason });
        ctx.ui.notify(`Goal paused: ${reason}`, "warning");
        return;
      }

      // ── 继续下一轮 ──
      const reason = !verification.ok
        ? `${evaluation.reason}\nDeterministic verifier failed (${verification.exitCode ?? "unable to run"}):\n${verification.output.slice(-6000)}`
        : `${evaluation.reason}\nNext action: ${evaluation.nextAction}`;
      goal = { ...next, lastReason: reason };
      persist();
      pi.sendMessage({
        customType: ENTRY_TYPE,
        content: buildContinuation(goal, reason),
        display: true,
        details: { turn: goal.turns, verification },
      }, { triggerTurn: true, deliverAs: "followUp" });
    } finally {
      continuing = false;
    }
  });
}

// ═══════════════════════════════════════════════════════════
// 多 Agent 辅助函数
// ═══════════════════════════════════════════════════════════

/**
 * 简单的目标拆分策略（进阶：用 LLM 分析）
 * 按关键词 / 分号 / 序号拆分
 */
function decomposeGoal(goalCondition: string): { role: string; description: string }[] {
  const tasks: { role: string; description: string }[] = [];

  // 拆分依据：分号、换行、序号列表
  const parts = goalCondition
    .split(/[;；\n]+|(?:^|\s)\d+[、.．]/)
    .map(s => s.trim())
    .filter(s => s.length > 5);

  if (parts.length <= 1) {
    // 无法拆分 — 尝试 llm 拆分（简化为返回默认拆解）
    tasks.push({ role: "explore", description: `分析并理解: ${goalCondition}` });
    tasks.push({ role: "implement", description: `实现: ${goalCondition}` });
    tasks.push({ role: "verify", description: `验证: ${goalCondition}` });
    return tasks;
  }

  parts.forEach((part, i) => {
    const role = i === 0 ? "explore" : i === parts.length - 1 ? "verify" : "implement";
    tasks.push({ role, description: part });
  });

  return tasks;
}
