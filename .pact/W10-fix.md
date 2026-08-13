# 任务包 W10-fix · 收尾 W10 的两个缺口

W10 上一次执行在 **step 56 处中途挂起**（无报错、进程不退），实现做了大半但没写完也没输出交付说明。orchestrator 验收后确认：已完成部分质量合格且测试全绿（236 passed），但有两处未完成。本任务只补这两处。

**已验收通过、不要动的部分：** `src/sessions/modes.ts`（ModePolicy 参数化正确，经探针验证三级中文策略各不相同、Challenge 各级均为 none、Coach 与 Conversation 仅阈值不同）、`src/corrections/scheduler.ts`（W9 已验收的纯函数）、命令注册在 auth 之后的 middleware 顺序（已验证未授权用户的 `/coach` 被静默丢弃）。

---

## 缺口 1（必补）Retry 闭环只做了一半

**现状：** `src/agent/tutor.ts` 能产出 `retryEvaluation`（模型判定用户重说是否改善），schema 也有该字段。**但没有任何代码把判定写进数据库**——全仓搜索 `RETRY_SUCCEEDED` 与 `retryStatus` 在 `src/` 下零命中（schema 定义除外），`src/db/repositories/learningEvents.ts` 只导出了一个 `insertMany`。

**为什么必须补：** §3.7 的 mastery 完全由 Learning Events 计算——「Retry 成功」若只体现在回复文本里，掌握度就永远不会因为用户改对而提升，§15.2「能延迟纠错且要求 Retry」这条验收也无从验起。判定必须落成**数据**。

**要做的：**

1. `detected_issues.retry_status` 按判定写入 `SUCCEEDED` / `FAILED`（列与枚举 W2 已建好，不要改 schema）。
2. 产生对应 learning event：成功写 `RETRY_SUCCEEDED`；失败**不要**伪造成功事件（§9.1 明确禁止制造伪造学习事件），按需写 `USER_ERROR` 或不写，但绝不写成成功。
3. Learning Event 需要确定性 dedupe key（§9.2），使同一 turn 重复处理不产生重复事件。
4. 写入与 corrections 的其它写入放在同一事务里（§8.1 第 12 步）。

## 缺口 2（必补）命令路由零测试

**现状：** `src/telegram/commands/index.ts` 已实现并接线，但**全仓没有任何测试提及 `registerCommands` / `switchToCoach` / `/coach`**。

**交底一个坑（我验收时踩过）：** `tests/telegram/helpers.ts` 的 `textUpdate()` 生成的消息**不带 `entities`**。grammY 的 `bot.command()` 依赖 `bot_command` entity 来识别命令，所以直接用现有 helper 造 `/coach` 消息，命令处理器**不会触发**——这会让你误以为路由坏了。请给 helper 加一个带 `entities` 的命令消息构造函数（或在测试内联构造），不要改动 `textUpdate` 既有签名以免影响其它测试。

**要覆盖的：**

- 授权用户发 `/talk` `/coach` `/challenge` `/end` 各自触达对应 handler
- **未授权用户发 `/coach` 被静默丢弃**：handler 未被调用、无任何 Telegram API 调用、不写 `telegram_updates`（这是阶段 1 核心安全验收项的回归防护）
- `/coach` 立即冲刷 pending 纠错（`explicitRequest = true`），且同一批 issue 不会被呈现两次
- `/end` 触发最后一次呈现且 `requestRetry` 为 false
- 预留但未启用的命令（`/roleplay` `/review` `/vocab` `/grammar` `/listening` `/progress` `/cost`）回复"尚未启用"且**不触发任何 provider 调用**
- 未知命令有兜底回复

---

## Owns

```
src/db/repositories/learningEvents.ts
src/db/repositories/detectedIssues.ts
src/corrections/turnHooks.ts
src/sessions/orchestrator.ts
src/sessions/textTurn.ts
src/sessions/voiceTurn.ts
src/telegram/commands/index.ts
tests/telegram/helpers.ts        ← 仅新增命令消息构造函数，不改既有签名
tests/telegram/**
tests/corrections/**
tests/sessions/**
```

**禁止触碰：** `INTERFACES.md`、`docs/**`、`.pact/**`、`src/db/schema/`、`src/corrections/scheduler.ts`、`src/sessions/modes.ts`、`src/usage/`、`src/speech/`、`src/config/`、`src/observability/`。

不新增依赖。不得发起任何真实 API 调用。

---

## Definition of Done

- `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿
- 全仓搜索 `RETRY_SUCCEEDED` 在 `src/` 下有实际使用（不只是类型定义）
- Retry 失败路径**不产生**成功事件，必须有测试断言
- 未授权用户发命令被丢弃，必须是真实断言（且有一条对照测试证明授权用户能触达，否则前者是空转）
- 只改 Owns 内文件

## 交付说明

三段中文：**已完成 / 未完成或有疑问 / 需要 orchestrator 决策**。
