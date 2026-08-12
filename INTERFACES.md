# INTERFACES · jp-coach 模块契约

*Orchestrator 看守。Worker 不得擅自修改本文件；需要变更接口时在交付说明里提出，由 orchestrator 决定。*

**权威设计文档：** [`docs/architecture.md`](docs/architecture.md)（V1.1）。本文件只定义**模块边界与跨模块契约**，不重复架构决策。冲突时以 architecture.md 为准。

---

## 0. 技术栈锁定

| 项 | 值 | 备注 |
|---|---|---|
| Node | ≥ 22（本机 v25.9.0） | ESM，`"type": "module"` |
| 包管理 | pnpm 10 | 不使用 npm/yarn |
| 语言 | TypeScript 5，`strict: true` | 禁用 `any`，禁用 `@ts-ignore` |
| 测试 | vitest | 单元测试与集成测试同框架 |
| Bot | grammY 1.45+ | Long Polling |
| 校验 | Zod 4 | 配置、Provider 返回值、LLM 输出 |
| ORM | Drizzle ORM + `pg` | 见 §4 连接约束 |

模块解析用 `node16`/`nodenext`，相对导入**必须带 `.js` 扩展名**（ESM 要求）。

---

## 1. 模块边界与所有权

```
src/
  telegram/       bot、middleware、commands、message renderer
  sessions/       session 生命周期、orchestrator、状态机
  agent/          tutor policy、context builder、output schemas
  corrections/    pending issues、呈现策略、retry 跟踪
  learning/       daily planner、curriculum、review、mastery
  memory/         profile、knowledge、learning events
  speech/         audio lifecycle、normalizer、STT/TTS 契约与实现
  db/             schema、migrations、repositories
  scheduler/      reminders、定时器管理、retries
  usage/          计量、成本计算、预算
  config/         经校验的环境配置
  observability/  日志、指标、correlation ID
  app.ts          组装与启动
```

### 依赖方向（单向，禁止反向或环形）

```
telegram → sessions → { agent, corrections, learning, memory, speech, usage }
                                    ↓
                                   db
config、observability 可被任何模块依赖，且它们不依赖任何业务模块。
```

**硬性禁止：**

1. `telegram/` 不得直接调用任何供应商 SDK（OpenAI / MiniMax / LLM），也不得直接访问 `db/`。
2. 任何模块不得在 `db/` 之外拼接 SQL 或直接使用 `pg` 客户端。
3. 业务模块不得直接读 `process.env`，一律经 `config/`。
4. 业务模块不得直接 `console.log`，一律经 `observability/` 的 logger。

---

## 2. config 契约

`src/config/index.ts` 导出：

```ts
export const config: AppConfig;          // 冻结对象，模块加载时完成校验
export type AppConfig = { ... };         // 由 Zod schema 推导，不手写
```

**要求：**

- 全部环境变量按 `docs/architecture.md` §17 定义，用单个 Zod schema 校验。
- **fail fast**：校验失败时打印**所有**错误字段后 `process.exit(1)`，不得以 `undefined` 进入运行态。
- 错误信息**不得回显值**（只报字段名与原因），避免密钥进日志。
- 带默认值的项在 schema 中声明默认值，不在使用处兜底。
- 导出的 config 对象用 `Object.freeze`。

`.env.example` 必须列全所有变量，密钥类留空。**真实 `.env` 必须在 `.gitignore` 中。**

---

## 3. observability 契约

```ts
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg:  string, fields?: Record<string, unknown>): void;
  warn(msg:  string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export const logger: Logger;
export function withCorrelationId<T>(id: string, fn: () => Promise<T>): Promise<T>;
```

**要求：**

- 结构化 JSON 输出（生产），本地可读格式（开发）。
- **自动脱敏**：字段名匹配 `/token|key|secret|password|authorization|connection_string|database_url/i` 的值一律替换为 `<redacted>`，且对嵌套对象递归生效。
- 每个 update/turn 分配 correlation ID 并贯穿全链路日志。
- 不记录完整学习内容，长文本字段截断至 200 字符。

---

## 4. db 契约

### 4.1 连接（**这是 architecture.md R1 的落地点，不可自行"优化"**）

```ts
export const db: NodePgDatabase<typeof schema>;
export async function closeDb(): Promise<void>;
```

- 驱动用 `pg`（node-postgres）+ Drizzle 的 `node-postgres` adapter。**不要用 `neon-http`**（它不支持交互式事务）。
- 连接池参数**必须**来自 config，且默认值为：`max = 2`、`idleTimeoutMillis = 15000`、`connectionTimeoutMillis = 10000`。
- **严禁**任何形式的固定频率数据库轮询、keep-alive ping、连接预热。
- 数据库空闲时必须能真正断开，让 Neon compute 休眠。任何"保持连接活跃"的写法都是 bug，不是优化。

### 4.2 Repository 风格

- 每张表一个 repository 模块，导出纯函数，第一个参数为执行器：

```ts
type Executor = NodePgDatabase<typeof schema> | PgTransaction<...>;
export async function insertTurn(tx: Executor, input: NewTurn): Promise<Turn>;
```

  这样同一函数既可在事务内也可在事务外调用。

- 不使用 class、不使用全局单例 repository。
- 时间戳统一 `timestamptz`，写入用数据库时间（`defaultNow()`），业务层不传本地时间。

---

## 5. telegram 契约

```ts
export function createBot(deps: BotDeps): Bot<AppContext>;
export interface BotDeps {
  config: AppConfig;
  logger: Logger;
  handleUpdate(ctx: AppContext): Promise<void>;   // 由 sessions/ 提供
}
```

**middleware 顺序固定（不可调整）：**

```
1. correlationId   为本次 update 生成 ID 并绑定 logger
2. auth            telegram_user_id !== ALLOWED_TELEGRAM_USER_ID → 立即静默返回
3. dedupe          update_id 已存在 → 立即返回，不进入业务
4. route           分发到 sessions/
```

**auth 必须是第一道业务校验。** 未授权 update 不得触发任何外部 API 调用、不得写入除必要审计外的数据、不得返回包含系统信息的错误。

---

## 6. 健康检查（**极易写错，单独列出**）

若实现 health endpoint：

- **绝对不得查询数据库。** 不要写 `SELECT 1`。
- 平台探针会以 30 秒级频率调用它；任何 DB 访问都会让 Neon compute 全天候不休眠，直接击穿 §4.1 的全部设计。
- 只返回进程存活与版本，形如 `{ status: "ok", version }`。
- 不暴露配置、连接串或用户数据。

---

## 7. Definition of Done（每个任务包通用）

交付前必须全部满足，未满足即视为未完成：

- [ ] `pnpm typecheck` 通过，零错误
- [ ] `pnpm lint` 通过
- [ ] `pnpm test` 通过，且**新增代码有对应测试**
- [ ] 只修改本任务 Owns 范围内的文件
- [ ] 未引入任务未声明的依赖
- [ ] 无 `any`、无 `@ts-ignore`、无 `console.log`
- [ ] 无密钥、无真实连接串进入仓库
- [ ] 交付说明写明：**已完成 / 未完成或有疑问 / 需要 orchestrator 决策的点**

**诚实优先于完成度。** 做不完或不确定的部分，在交付说明里明说，不要用占位实现假装完成，也不要为了让测试通过而弱化断言。

---

*Owner: orchestrator（Claude）。Worker: Kimi K3 via opencode。*
