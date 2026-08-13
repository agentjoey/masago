# 任务包 W10-ci · 修复 CI 红灯

**紧急度：main 分支 CI 当前是红的。** 本任务只做这一件事，不要顺带改任何别的东西。

---

## 问题

W10-fix 新增的两个集成测试在 CI 里失败：

```
tests/corrections/detectedIssues.integration.test.ts:4
tests/corrections/turnHooks.integration.test.ts:10
→ Error: ENOENT: no such file or directory, open '.env'
```

两处根因，**都要修**：

1. **`process.loadEnvFile()` 无保护**：CI 环境没有 `.env` 文件，直接抛 ENOENT。
2. **顶层 `await import('../../src/db/index.js')`**：即使加了 try/catch，这行也会构造连接池并触发 `src/config` 的 fail-fast（CI 无必需环境变量），照样失败。

CI 的测试步骤是 `pnpm exec vitest run --exclude 'tests/db/**'`，而这两个文件在 `tests/corrections/` 下，所以会被执行。

---

## 仓库里已有正确范式，照抄

`tests/telegram/integration.test.ts` 是 W3 时代建立的范式，**已在 CI 中稳定运行**。它的结构是：

```ts
try {
  process.loadEnvFile();
} catch {
  // CI 没有 .env：本文件全部用例跳过
}

const HAS_DB = Boolean(process.env['DATABASE_URL']);

type Modules = { /* 用 typeof import(...) 声明各模块类型 */ };
let modules: Modules | undefined;

function need(): Modules {
  if (modules === undefined) throw new Error('database modules were not loaded');
  return modules;
}

describe.skipIf(!HAS_DB)('...', () => {
  beforeAll(async () => {
    const dbModule = await import('../../src/db/index.js');
    // ...其余模块同样在此处懒加载，赋值给 modules
  });
  // 用例内通过 need() 取模块
});
```

关键点：**模块导入必须发生在 `beforeAll` 内部，不能在文件顶层**——顶层 `await import` 不受 `describe.skipIf` 控制，一定会执行。

---

## 要做的

把 `tests/corrections/detectedIssues.integration.test.ts` 与 `tests/corrections/turnHooks.integration.test.ts` 改为上述范式。

**不要改动任何测试的断言逻辑与覆盖范围**——这两个文件的用例是 W10-fix 刚验收通过的，包括「Retry 失败时零 learning event」这条关键断言。只改模块加载方式与跳过守卫。

## Owns

```
tests/corrections/detectedIssues.integration.test.ts
tests/corrections/turnHooks.integration.test.ts
```

**禁止触碰其它任何文件。** 特别是不要改 `.github/workflows/ci.yml` 去排除这两个文件——排除会让它们在 CI 中静默失效，而守卫模式能在有数据库时自动生效。

---

## 验证方式（必做，这是本任务的核心）

改完后**必须忠实模拟 CI**，不能只跑本地全量测试：

```bash
mv .env .env.bak
pnpm exec vitest run --exclude 'tests/db/**'
mv .env.bak .env
```

预期结果：**零失败**，这两个文件的用例显示为 skipped。

**务必确保 `.env` 被还原**——它含真实数据库连接串且不在 git 中，弄丢了要重新配。建议用 `trap` 保证异常时也能还原。

然后再跑一次带 `.env` 的完整测试，确认 256 条仍全绿（有数据库时用例应正常执行而非跳过）。

## Definition of Done

- 无 `.env` 时 `pnpm exec vitest run --exclude 'tests/db/**'` 零失败
- 有 `.env` 时全量测试仍 256 passed
- `.env` 完好无损
- 只改了 Owns 里那两个文件

## 交付说明

三段中文：**已完成 / 未完成或有疑问 / 需要 orchestrator 决策**。附上两次验证的实际输出。
