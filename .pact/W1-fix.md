# 任务包 W1-fix · Review 返工

Orchestrator 验收 W1 后的返工项。你的交付整体质量好，config schema 与测试结构无需改动；以下两个 bug 必须修，三个决策点已拍板。

**Owns：** `src/observability/redact.ts`、`tests/observability/redact.test.ts`、`package.json`、`tsconfig.build.json`（新建，已批准）、`src/app.ts`。
**禁止触碰：** 其它一切。

---

## BUG-1（必修 · 安全）redact 对非 plain object 直接放行

`redact.ts:39-41`：

```ts
if (!isPlainObject(value)) {
  return value;      // ← 原样返回，完全绕过脱敏
}
```

**实证：** 给一个 `Error` 挂上 `connectionString` 属性后调用 `redact`，值原样输出：

```
expected 'postgres://u:pw@h/db' to be '<redacted>'
```

**为什么这条严重：** 最常被写进日志的对象就是 Error，而 `pg` 连接失败抛出的 Error 常带连接串或含密码的配置。这直接违反 `INTERFACES.md` §3 与 `docs/architecture.md` §10.2「日志中屏蔽 token、连接串」。

**修法要求：**

- **原则：任何对象都不得未经处理地穿过 `redact`。**
- `Error`（含子类）：转成普通对象 `{ name, message, stack }`，并**继续处理其 own enumerable 属性**（`cause`、`code`、以及像 `connectionString` 这样的自定义字段都要走脱敏）。`stack` 按 200 字符截断规则处理。
- `Date`：原样返回（安全，且可读）。
- `Buffer` / TypedArray：返回 `<binary:N bytes>` 占位，不要把内容打进日志。
- `Map` / `Set`：转为可序列化形式后递归处理其条目。
- 其它类实例（未知构造函数）：**按 own enumerable 属性递归处理**，不要整体放行。
- 函数：返回 `<function>`。

## BUG-2（必修 · 数据丢失）循环检测误伤共享引用

`redact.ts:35 / 45`：对象加入 `seen` 后从不移除，导致**同一对象被引用两次**（DAG，非循环）时第二次被误判为 `<circular>`。

**实证：**

```ts
const shared = { name: 'shared' };
redact({ x: shared, y: shared });
// y 变成 '<circular>'，内容静默丢失
```

**修法：** `seen` 只应跟踪**当前祖先链**。递归处理完一个对象的子树后把它从 `seen` 中 `delete`，这样只有真正的祖先自引用才判定为循环。

---

## 必须补充的测试

在 `tests/observability/redact.test.ts` 增加：

1. `Error` 上的自定义敏感属性（如 `connectionString`、`apiKey`）被脱敏，且 `name` / `message` 仍可读
2. Error 的 `cause` 链中的敏感字段也被脱敏
3. 共享引用（`{ x: shared, y: shared }`）**不**被标记为 `<circular>`，两处都保留完整内容
4. 真正的循环引用（`obj.self = obj`）仍被正确标记为 `<circular>`
5. `Buffer` 不把内容写入日志
6. 未知类实例的敏感属性被脱敏

---

## 已拍板的三个决策（按此执行）

| 你的提问 | 决定 | 说明 |
|---|---|---|
| 是否允许引入 `tsx` | **允许**。加入 devDependencies，`dev` script 改为 `tsx watch src/app.ts` | 这个项目要连续开发数周，没有 watch 模式的代价远大于一个 devDependency |
| `LOG_LEVEL` 必填还是默认 `info` | **保持默认 `info`**，你的选择正确 | 无需改动 |
| 是否允许新增 `tsconfig.build.json` | **允许**。`build` 用它，只编译 `src/`，产出不含 `tests/` | 阶段 5 要部署到 Railway，产物里不该有测试代码 |

顺带（非 bug，请一并处理）：`src/app.ts` 的 `shutdown()` 目前直接 `process.exit(0)`。改为**先执行已注册的清理钩子再退出**，预留一个 `onShutdown(fn)` 注册点——W2 的 `closeDb()` 和 W3 的 bot stop 都要挂上去。现在没有清理项，但结构要先留出来。

---

## Definition of Done

- `pnpm typecheck`、`pnpm lint`、`pnpm test` 全绿
- 上述 6 条新测试全部存在且真实断言（不得为了通过而弱化）
- 不改动 Owns 之外的文件

## 交付说明

三段中文：**已完成 / 未完成或有疑问 / 需要 orchestrator 决策**。
