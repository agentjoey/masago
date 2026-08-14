# MCP 第二界面 —— 设计方案

> 2026-08-14。落实 [`architecture.md`](architecture.md) §11。
>
> **状态：设计，未实现。** 本文给出可直接施工的接口、鉴权流程与工作量估算。

---

## 0. 先说清楚这个界面不做什么

§11 已经定过：**MCP 不是主链路**。这条结论在动手前要重新确认，因为它决定了
下面所有取舍。

理由是控制权的位置：**工具何时被调用由客户端（ChatGPT）决定**，服务端无法强制。
这会打断两件依赖「每一轮都经过」的机制：

| 机制 | 为什么会坏 |
|---|---|
| Correction Scheduler（§7.2） | 纠错节奏按「第几轮」计数。模型可能一轮不调、一轮调三次，节奏就没了 |
| 学习事件流（§3.3） | 掌握度要能从事件重算。漏记的轮次无法补，历史就有洞 |
| FSRS 排程（§3.1） | 评分依据是「出题 → 作答」的配对。没有出题就没有可信的评分 |

所以本方案里 **MCP 只读**。没有一个工具会写 `review_queue` 或 `learning_events`。

> 想在 ChatGPT 里自由练对话是可以的——那属于「不求纠错闭环」的用法，
> §11 的分工表已经把它划给 ChatGPT 了。它不需要 MasaGo 提供工具。

---

## 1. 客户端侧的事实（2026-08 核实）

| 项 | 事实 | 影响 |
|---|---|---|
| 入口 | ChatGPT 网页版 设置 → Apps → 高级 → 开发者模式 | 仅网页；手机端用不了 |
| 计划 | Pro / Plus / Business / Enterprise / Edu | 用户是 Plus，可用 |
| 服务器位置 | 必须是**公网 HTTPS**，不能是本机或内网 | MasaGo 已在 Railway 上，满足 |
| 传输 | OpenAI 文档写的是 SSE（URL 以 `/sse/` 结尾）；第三方资料称 Streamable HTTP 也支持 | **两个都实现**，SSE 为准 |
| 鉴权 | OAuth（支持 CIMD、动态注册），或 **无鉴权** | 见 §3 |
| 必备工具 | 接入 chat / deep research 需要 `search` 与 `fetch`，且 schema 固定 | 见 §2.1 |

MCP 协议本身（2025-06-18 修订）：Streamable HTTP 取代 SSE 成为标准远程传输，
SSE 标记为废弃；鉴权用 OAuth 2.1，**服务器只作 resource server**，强制 PKCE，
用 RFC 9728 做保护资源发现、RFC 8414 做授权服务器元数据、RFC 8707 把令牌绑定到
特定服务器。

> SDK：`@modelcontextprotocol/sdk` 1.30.0（MIT），另有 `@modelcontextprotocol/express` 2.0.0
> 提供 Express 集成与 Host 头校验。MasaGo 现在用的是 Node 原生 `http`，
> 不打算为此引入 Express——SDK 的 transport 可以直接挂在原生 handler 上。

---

## 2. 工具设计

### 2.1 `search` 与 `fetch`（ChatGPT 要求的两个）

schema 是固定的，不能改名或改形状。好在 MasaGo 的数据天然就是一个可检索的语料库。

**`search(query: string)`** → `{ results: [{ id, title, url }] }`

检索范围（按相关度合并）：

- 知识项：假名、单词、助词 —— 匹配表记、读音、释义
- 例句：匹配日语原文与中文译文
- 错题本：匹配学习者写错的原句

`id` 用带前缀的稳定标识：`kana:a`、`vocab:本#ほん`、`particle:wo`、`sentence:48302`、
`issue:<uuid>`。`url` 指向 Mini App 的对应页面（`https://<host>/app#kana/a`），
这样 ChatGPT 给出的引用是可点开的。

**`fetch(id: string)`** → `{ id, title, text, url, metadata }`

`text` 是给模型读的完整内容。以单词为例：

```
本（ほん）
释义：book
等级：N5　Genki 第 2 课
学习状态：已学 12 天，练习 8 次，错 1 次
下次复习：2026-08-17
出现在这些场景：学校、爱好
例句：私は本を読みます。（我读书。）
```

**所有字段都来自库里已有的数据，没有一个字是现编的**（§8）。

### 2.2 MasaGo 自己的工具

| 工具 | 返回 | 对应主链路 |
|---|---|---|
| `get_progress` | 三类知识项的进度、待复习数、连续天数、最近 7 天活动 | `/progress` |
| `get_today` | 今天该学什么：新项、到期复习、是否因积压暂停新项 | `/today` |
| `get_errors(limit)` | 错题本：原句、建议、原因、时间 | Mini App 错题本 |
| `get_report(period)` | 周报 / 月报的原始数字（含「这些还不稳」） | 周报 push |

四个都直接复用 `miniapp/data.ts` 与 `learning/reportFacts.ts` 里已有的函数。
**不新写一套统计**——bot、Mini App、MCP 出的数字必须是同一个来源，
否则三处会慢慢对不上（这条在 `miniapp/data.ts` 的注释里已经写过）。

### 2.3 明确不提供的工具

- 任何写操作（记录复习、标记掌握、调整排程）
- 出题（`next_question` 之类）—— 出了题却收不到答案，FSRS 会被污染
- 「讲解某个词」—— `/explain` 已经在主链路上；ChatGPT 自己就会讲，不必绕一圈

---

## 3. 鉴权：两条路

这是整个方案里工作量最大、也最需要先拍板的部分。当前 MasaGo 的鉴权手段
（Telegram initData HMAC）对 MCP 不适用——客户端是 ChatGPT，不是 Telegram webview。

### 方案 A：能力 URL（推荐先做）

MCP 端点自带一段长随机串：

```
https://<host>/mcp/9f3a…（64 字符）
```

ChatGPT 侧配置为「无鉴权」，URL 本身就是凭据。

**代价**：URL 会出现在浏览器历史、服务端访问日志里，也可能通过 referer 泄漏。
**影响面**：只读、单用户、内容是一个人的日语学习记录。真泄漏了，损失是
「别人知道我学了多少假名」。

配套的三条硬性要求：

1. 令牌存在环境变量（`MCP_ACCESS_TOKEN`），**不入库、不进 git**
2. 日志里必须打码——项目已有 `observability/redact.ts`，把这个值加进去
3. 提供轮换手段：改环境变量 → 重新部署 → 在 ChatGPT 里更新 URL

**工作量：约 150 行**（transport 挂载 + 6 个工具 + 令牌校验）。

### 方案 B：OAuth 2.1，用 Telegram 做身份证明（升级路径）

要做得正，就按 MCP 2025-06-18 来。但对单用户应用，**专门搭一个授权服务器
不划算**。有个更贴合的做法：**Telegram bot 本身就是身份提供方**。

```
1. ChatGPT 跳转到  /oauth/authorize?client_id=…&code_challenge=…（PKCE）
2. MasaGo 显示一个只有一个输入框的页面
3. MasaGo 通过 bot 给 ALLOWED_TELEGRAM_USER_ID 发一个 6 位一次性验证码
4. 用户把验证码填进去
5. 校验通过 → 下发 authorization code → ChatGPT 换 access token
6. 令牌绑定 learner_id，有效期 30 天，可在 Telegram 里 /revoke 撤销
```

好处：不引入新的口令，不建账号体系，而且**证明的是「此人控制着拥有这份数据的
Telegram 账号」**——正是我们想要的那个断言。

需要实现的端点：

| 端点 | 用途 |
|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728，告诉客户端去哪儿要令牌 |
| `/.well-known/oauth-authorization-server` | RFC 8414 元数据 |
| `/oauth/authorize` | 验证码页面 |
| `/oauth/token` | 换令牌，校验 PKCE |
| `/oauth/revoke` | 撤销 |

外加一张表 `mcp_tokens`（token 哈希、learner_id、过期时间、创建时间）。

**工作量：约 450 行 + 一次迁移。**

> 协议倾向于「服务器只做 resource server，授权服务器另设」。这里两者合一，
> 是单用户场景下的有意取舍，多用户（V4）时必须拆开。

### 建议

**先做 A。** 理由：MCP 本来就是低优先级的第二界面，先用起来才知道值不值得投入；
A 的 150 行如果证明这个界面没人用，损失很小。B 的设计写在这里，等到
①真的常用了，或②要多用户了，再动工。

---

## 4. 部署与算力

挂在**现有的那个 Railway service 上**，不新开——与「不拆分 service」的判断一致
（长轮询本就只能单实例，拆开计费单元翻倍）。

路由加在 `miniapp/server.ts` 已有的原生 HTTP handler 里：

```
/health                 现有，不碰 DB（§9.1 铁律）
/  /app  /api/*         现有 Mini App
/audio/kana/*           现有
/mcp/<token>            新增：Streamable HTTP
/mcp/<token>/sse        新增：SSE（ChatGPT 文档写的是这个）
```

**Neon 算力（§9.1）**：每次工具调用都会唤醒 compute。调用只在用户主动
在 ChatGPT 里对话时发生，profile 与 Mini App 相同，可以接受。但要加一道
**限流：每分钟 30 次**——代理循环跑飞时，别让它把免费额度烧掉。这是
MCP 独有的风险：Mini App 的调用由人点击驱动，MCP 的调用由模型驱动。

---

## 5. 风险

| 风险 | 说明 | 应对 |
|---|---|---|
| **能力 URL 泄漏** | 日志、历史、referer | 打码 + 可轮换 + 只读 |
| **代理循环打爆 Neon** | 模型驱动的调用没有人类节奏 | 限流 30 次/分 |
| **返回内容进入模型上下文** | 错题本是学习者自己写的句子；例句来自 Tatoeba | 都不是不可信的第三方输入，风险低。但**工具返回值一律当数据、不当指令** |
| **两处数字对不上** | MCP 另写一套统计 | 强制复用 `miniapp/data.ts`，不新写聚合 |
| **ChatGPT 改协议** | SSE 已被 MCP 标记废弃，OpenAI 文档仍在用 | 两种 transport 都挂，SDK 升级时一起调 |

---

## 6. 施工顺序

1. 令牌校验 + Streamable HTTP / SSE transport 挂载（`src/mcp/server.ts`）
2. `get_progress` / `get_today` / `get_errors` / `get_report` —— 直接包一层已有函数
3. `search` / `fetch` —— 需要一个跨知识项与例句的检索函数，是本方案唯一的新逻辑
4. 限流
5. 在 ChatGPT 开发者模式里实测：工具是否被正确发现、schema 是否被接受

**合计约 150 行 + 检索函数。** 第 3 步是唯一需要设计的部分，其余是接线。

---

## 7. 尚未确定

1. **ChatGPT 到底吃哪种 transport。** OpenAI 文档写 SSE，第三方说两种都行。
   两个都挂就不用赌，但要在实机上确认到底走了哪条
2. **`search` 的相关度怎么排。** 跨假名 / 单词 / 例句 / 错题四类，
   简单的字符串包含大概率够用（数据量：1,490 知识项 + 3,500 句），
   但没实测过
3. **要不要暴露 `sentence:` 类的 id。** 例句有 3,500 条，让 ChatGPT 能逐条 fetch
   等于把整个语料库开放出去。Tatoeba 是 CC BY 2.0 FR，本来就是公开的，
   但署名要求需要落到 `fetch` 的返回里

## 参考

- [ChatGPT 连接自定义 MCP 服务器（OpenAI 文档）](https://developers.openai.com/api/docs/mcp)
- [MCP 授权规范 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
