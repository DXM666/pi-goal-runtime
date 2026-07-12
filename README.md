# Pi Goal Runtime

> **语言:** 中文 | [English](README.en.md)

[Pi](https://pi.dev/docs/latest) 的**持久化可验证目标循环扩展**。它让 AI agent 在各轮次之间持续工作，直到独立评估器确认目标完成、确定性校验命令通过，或触发安全停止条件。

## 核心特性

- `/goal` 条件驱动循环（类似 Claude Code 的 goal 工作流）
- 使用活跃 Pi 模型和凭证进行独立评估
- 可选的硬性校验命令门禁（如 `npm test`、`eslint`）
- 会话持久化状态，支持重载和恢复
- 显式的 `running`、`blocked`、`paused`、`budgetLimited`、`achieved` 状态
- 轮次、时间、token/成本、重复结果、评估器错误等多维限制
- 上下文窗口超过阈值时自动压缩
- Goal Hook 事件系统（pre-turn、post-turn、on-blocked、on-achieved、on-paused、on-budget-limited、on-compact）
- 同一会话中多目标历史记录追踪
- 独立评估器支持指数退避重试
- 进度反馈注入到下一轮 agent 提示中

## 环境要求

- Node.js 20+
- Pi 0.80.6+
- 配置好的 model/provider

## 安装

```bash
npm install

# 从 GitHub 安装（推荐）
pi install https://github.com/DXM666/pi-goal-runtime
# 或 SSH 方式
pi install git:git@github.com:DXM666/pi-goal-runtime

# 本地绝对路径安装
pi install /absolute/path/to/pi-goal-runtime
```

开发模式（无需安装）：

```bash
pi --extension ./src/goal.ts
```

卸载：

```bash
pi remove /absolute/path/to/pi-goal-runtime
```

## 命令参考

```text
/goal <条件> [--verify <命令>] [--max-turns N] [--max-minutes N] [--max-no-progress N] [--max-tokens N] [--max-cost N] [--compact-on-oversize]
/goal-status
/goal pause | clear | stop | cancel
/goal history
/goal clear-history
/goal-resume
/goal-hook [事件名]
```

### Headless / CI 模式

```bash
pi --print --goal-condition "all tests pass" --goal-max-turns 20 "Fix the failing tests"
```

### 示例

```text
/goal 所有测试通过且 lint 干净 --verify npm test --max-turns 30 --max-minutes 240 --max-tokens 100000 --max-cost 1.00
```

### 参数说明

| 参数 | 默认值 | 含义 |
|---|---:|---|
| `--max-turns` | 30 | 最大评估轮次数 |
| `--max-minutes` | 240 | 时间限制（分钟） |
| `--max-no-progress` | 3 | 连续无进展轮次上限 |
| `--max-tokens` | 无 | Token 预算（input + output + cache） |
| `--max-cost` | 无 | 成本预算（USD） |
| `--compact-on-oversize` | false | 上下文超过 80% 时自动压缩 |
| `--verify` | 无 | 确定性校验命令 |

## Token 与成本预算

配置 `--max-tokens` 或 `--max-cost` 后，扩展追踪 worker 轮次和评估器调用的累计 token 消耗。超过预算时目标进入 `budgetLimited` 暂停状态。

预算检查在两个时机执行：
1. **验证前** — 提前退出以节省成本
2. **评估器调用后** — 捕获评估器导致的溢出

状态栏会显示 token 使用量：`goal 3/30 (45.2k/100.0k tok)`

## 上下文自动压缩

启用 `--compact-on-oversize` 后，扩展通过 Pi 的 `getContextUsage()` API 监控上下文使用率。超过 80% 时触发压缩，压缩指令会自动保留目标进度和下一步行动。

## Goal Hook 系统

| 事件 | 触发时机 | 可阻塞？ |
|---|---|:---:|
| `pre-turn` | 校验/评估运行前 | ✓ 是 |
| `post-turn` | 评估完成后 | ✗ 否 |
| `on-blocked` | worker 报告阻塞时 | ✗ 否 |
| `on-achieved` | 目标达成时 | ✗ 否 |
| `on-paused` | 目标因任何原因暂停时 | ✗ 否 |
| `on-budget-limited` | 预算耗尽时 | ✗ 否 |
| `on-compact` | 上下文压缩时 | ✗ 否 |

## 完成判定协议

每个 `agent_settled` 事件后：

1. 在当前工作目录执行校验命令
2. 调用模型独立评估目标、worker 输出和校验证据
3. 仅当评估器判定完成 **且** 校验通过时，目标变为 `achieved`
4. 否则注入评估原因和下一步行动，开启下一轮

Worker 可以输出 `GOAL_COMPLETE` 或 `GOAL_BLOCKED` 标记，但这些是证据而非权威。单独的标记不能覆盖失败的校验或独立评估器的判断。

## 状态机

```
                  /goal <条件>
                     │
                     ▼
              ┌──────────────┐
              │   running    │ ←─────────────────────────┐
              └──────┬───────┘                          │
                     │                                  │
       ┌─────────────┼─────────────┬──────────────┐    │
       │             │             │              │    │
       ▼             ▼             ▼              ▼    │
  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌────────┐  │
  │achieved │  │ blocked │  │ paused  │  │budget  │  │
  └─────────┘  └─────────┘  └────┬────┘  │Limited │  │
                                 │       └───┬────┘  │
                                 │           │       │
                            /goal-resume     │       │
                                 └───────────┘───────┘
```

停止条件：
- 轮次 `>= maxTurns`
- 时间 `>= maxMinutes`
- token `>= maxTokens`
- 成本 `>= maxCost`
- 评估器连续失败 3 次
- 连续无进展 `>= 3` 轮
- pre-turn hook 主动阻塞
- 用户主动暂停

## 持久化与恢复

状态以 `pi-goal-runtime` 自定义条目追加到 Pi 的 session JSONL 文件中，不消耗模型上下文。v1 版本条目在加载时会进行内存迁移。

恢复活跃目标后不会自动执行命令，需手动运行 `/goal-resume`。

## 安全模型

- 不修改 Pi 的 tool 权限
- 校验命令由用户显式提供，使用其当前 OS 权限执行
- 阻塞判定停止自动执行而非反复猜测
- 连续 3 次评估器失败暂停目标（带指数退避重试）
- 所有限制条件均暂停目标，不会错误标记为完成

## 项目结构

```
pi-goal-runtime/
├── src/
│   ├── goal.ts          # 扩展入口：注册命令、flags、事件处理
│   ├── core.ts          # 核心工具：参数解析、校验执行、预算检查
│   ├── evaluator.ts     # 独立评估器 + 成本估算
│   ├── hooks.ts         # Goal Hook 事件系统
│   └── types.ts         # 集中式类型声明（interface / type）
├── test/
│   ├── core.test.ts     # 核心工具测试
│   └── evaluator.test.ts# 评估器测试
├── benchmarks/          # Harbor 基准测试适配器
├── package.json         # v0.3.0, ESM, exports hooks + core
├── tsconfig.json        # strict, NodeNext, ES2022
├── CHANGELOG.md
├── README.md            # 中文文档
└── README.en.md         # English documentation
```

## 数据流

```
/goal "fix tests" --verify npm test
       │
       ▼
┌─────────────────────┐
│  命令处理器 (goal.ts) │
│  解析参数 → 创建状态  │
│  persist() → 写磁盘  │
└──────────┬──────────┘
           │ sendMessage(kickoff)
           ▼
┌─────────────────────┐
│  Pi Agent (Worker)   │
│  执行实际编码工作     │
└──────────┬──────────┘
           │ agent_end → 捕获输出 + token usage
           ▼
┌──────────────────────────────────────────┐
│  agent_settled 处理器（核心循环）          │
│  1. 累加 token usage                     │
│  2. 预算检查                              │
│  3. 上下文压缩（可选）                     │
│  4. pre-turn hook                        │
│  5. 确定性校验                            │
│  6. 独立评估（指数退避）                   │
│  7. post-turn hook                       │
│  8. 判定 → achieved / blocked / 继续      │
└──────────────────────────────────────────┘
```

## 开发

```bash
npm ci
npm run check
npm test
```
