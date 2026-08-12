# Telegram 日语学习陪练 Agent

## 产品与技术架构设计方案

**版本：** V1.1（基于 V1.0 基线稿的可行性修订）
**日期：** 2026-08-12
**适用范围：** 个人自用、长期运行的 Telegram 日语学习与口语陪练 Agent
**文档状态：** 可作为产品定义、架构评审、开发计划与验收依据

---

## 修订记录：V1.0 → V1.1

本版只改动经外部文档核实后**站不住的假设**与由此暴露的**设计缺口**，产品定义、学习闭环、课程引擎与记忆模型的核心思路全部保留。

| # | 修订 | 原因 | 影响章节 |
|---|---|---|---|
| R1 | 数据库连接策略从「pooled 长连接 + always-on」改为「小连接池 + 短 idle + 事件驱动 scheduler」 | Neon Free 为 100 CU-hours/project/月（≈0.25 CU × 400 小时），常驻长连接会让 compute 永不空闲，约每月第 17 天被 suspend | §5.2 §7.4 §11.1 §11.2 §16 §17 |
| R2 | Scheduler 从「DB 轮询 due jobs」改为「进程内定时器 + DB 持久化」 | 高频轮询会持续唤醒 Neon compute，使 R1 失效。真正决定 CU-hours 的是轮询频率而非连接池 | §4.3 §5.2 §12.2 §17 |
| R3 | 语音输入路径新增 remux 步骤，FFmpeg 从 fallback 升为常规依赖 | OpenAI 转写 API 支持格式为 mp3/mp4/mpeg/mpga/m4a/wav/webm，**不含 ogg**；Telegram 语音条是 OGG/Opus | §5.2 §6.2 §8.1 §8.2 §8.3 §9.1 §14 |
| R4 | 明确语音**输出**路径不需要转码 | 已核实 Telegram `sendVoice` 接受 .OGG/OPUS **或 .MP3 或 .M4A**，MiniMax 的 mp3 可直接作为语音条发送 | §4.1 §8.1 §8.3 |
| R5 | STT 选型从「默认 gpt-4o-transcribe」改为「gpt-transcribe 与 whisper-1 并列候选，由 benchmark 裁决」 | `gpt-transcribe` 已取代 `gpt-4o-transcribe` 成为推荐模型且更便宜（$0.0045 vs $0.006/min），但其 context/keyword hints 会放大「顺手改对语法」的倾向，与 Error Preservation 目标直接冲突 | §5.2 §6.1 §6.4 §16 §17 |
| R6 | Tutor 输出 schema 拆分为 `detectedIssues` 与 `correctionCard`，新增 Correction Scheduler 与 `detected_issues` 表 | V1.0 中「§2.1 延迟纠错」与「§5.4 每轮输出 corrections」之间没有交接机制，纠错节奏只能靠模型自觉，跨轮必然漂移，而这是 §15.2 的验收项 | §2.1 §5.4 §7.2 §14 §15 |
| R7 | 成本模型重估，LLM 主调用列为第一大项并引入 prompt caching | V1.0 §6.7 只对 TTS/STT 建模，而这两项合计不足总成本三成；预算保护手段因此对错了目标 | §6.7 §12.2 §12.4 |
| R8 | Railway 月度成本表述从「$5」改为「$5–10」 | $5 订阅含 $5 额度，但 RAM $10/GB·月、vCPU $20/vCPU·月，常驻进程叠加 FFmpeg 大概率略微超出额度 | §11.1 |

**未改动但已复核确认的关键事实：** MiniMax `speech-2.8-turbo` $60 / 1M characters、`speech-2.8-hd` $100 / 1M characters（与 V1.0 一致）；MiniMax T2A 输出格式 mp3/wav/flac/pcm；Telegram 单条语音发送上限 50 MB；OpenAI 转写单文件上限 25 MB；grammY 当前 1.45.1，维护活跃。

---

## 执行摘要

本方案定义一个通过 Telegram 提供文字与语音交互的长期日语学习陪练 Agent。它不是"回答日语问题的聊天机器人"，而是一套持续感知学习者水平、主动安排每日训练、在真实表达中延迟纠错、记录薄弱点并通过间隔复习再次测试的个人学习系统。

产品核心循环为：

> **Plan → Practice → Detect → Teach → Retry → Remember → Revisit**
> 规划 → 练习 → 发现问题 → 小范围教学 → 重新表达 → 形成记忆 → 未来复测

V1 的关键技术决策如下：

- **入口：** Telegram Bot，支持文字与语音消息。
- **交互模式：** Conversation、Coach、Challenge，另提供 Roleplay、Review 等快捷入口。
- **运行方式：** Telegram Long Polling；Railway Hobby 常驻单实例，不启用休眠。
- **应用形态：** TypeScript 模块化单体，使用 grammY、Zod、Drizzle ORM。
- **数据库：** Neon Postgres；**小连接池 + 短 idle timeout，配合事件驱动 scheduler，保证 compute 能回落到 scale-to-zero**；迁移和备份使用 direct connection。
- **语音基线：** OpenAI STT（模型由 Learner Japanese Benchmark 裁决）；MiniMax `speech-2.8-turbo` 用于日常对话，`speech-2.8-hd` 用于标准示范；所有外部能力均通过 Provider Adapter 接入。
- **音频路径：** 输入侧 Telegram OGG/Opus 需 remux 为 WebM/Opus 后送 STT（换容器不重编码）；输出侧 MiniMax mp3 可直接作为 Telegram 语音条发送，无需转码。
- **非实时语音：** 不使用 Realtime 作为主链路。Telegram 语音消息天然按 turn 分段，异步 STT → LLM → TTS 更简单、可控且便于保存学习事件。
- **纠错节奏由程序控制：** 模型每轮识别问题并落库，**何时呈现给用户由 Correction Scheduler 决定**，使延迟纠错成为确定性、可测试的行为。
- **长期资产：** Learner Memory、Error Bank、Vocabulary、Review Queue 与学习事件保存在 Neon；Railway 只承载可随时重建的无状态计算。
- **隐私：** 原始用户语音和 TTS 文件默认仅在临时目录短暂存在，发送或转写完成后删除。

V1 的成功不以"功能数量"衡量，而以是否跑通以下闭环衡量：用户每天可在 15–30 分钟内完成一节由 Agent 主动组织的课程；本轮真实表现能改变后续课程；重复消息不会造成重复学习记录；语音供应商故障时仍能降级为文字服务；部署被完全替换后长期学习记忆仍然存在；**且连续运行整月不会因基础设施额度耗尽而中断**。

---

# 1. 产品定位与目标

## 1.1 产品定位

产品面向希望长期提升日语实际表达能力的个人学习者，尤其适合 JLPT 知识水平高于口语水平、容易"认识但说不出来"、需要稳定陪练但不希望每天自行选课的人。

Agent 同时承担四个角色：

1. **陪练伙伴：** 维持自然对话，主动追问，提供旅行、生活、社交和工作场景。
2. **私人教练：** 纠正语法、措辞与语感，明确区分"语法正确"和"日本人更自然的说法"。
3. **课程规划者：** 根据近期表现、长期路线与兴趣自动生成 Daily Plan。
4. **复习系统：** 将错误、生词和未激活表达安排进未来对话，形成可观测的掌握度变化。

## 1.2 核心目标

- 每天提供一节 15–30 分钟、无需用户自行备课的日语训练。
- 提升主动词汇、口语流畅度、表达自然度和真实场景应对能力。
- 控制纠错节奏，避免自然对话被逐句打断。
- 将每次对话转换为结构化 Learning Events，持续更新 Learner Model。
- 让过去的错误和已学知识在未来被重新激活，而不是只被展示一次。
- 让系统在个人预算和低运维负担下 24/7 可用。

## 1.3 V1 用户边界

V1 是个人自用 MVP：

- 只允许一个配置好的 Telegram User ID 使用。
- 不做注册、支付、订阅、运营后台和组织管理。
- 不承诺精确音素、音高或 pitch accent 评分。
- 不做电话式双向实时通话。
- 不做 Web Dashboard；进度通过 Telegram 命令与摘要查看。

## 1.4 产品原则

- **先表达，后纠错：** Conversation Mode 中优先保持交流，通常在 3–5 轮或一个语义段结束后反馈。
- **少而重要：** 每个常规 session 最多重点纠正 3 项，每天最多 1 个核心新语法。
- **输出优先：** 新知识只占少量时间，主要时间用于召回、表达、重述和场景迁移。
- **自然度独立评价：** Grammar、Naturalness、Fluency 分开观察。
- **LLM 不是数据库：** 模型负责理解、教学、规划与评价；程序负责状态、幂等、记忆和调度。
- **节奏不交给模型：** 凡是需要跨轮一致的行为（何时纠错、何时复习、何时结束），由程序决策，模型只负责在被要求时把内容表达好。
- **可替换供应商：** STT、TTS、LLM 都不与业务逻辑绑定。

## 1.5 核心产品指标

早期不追求增长指标，优先观察学习有效性与可靠性：

| 维度 | 建议指标 | V1 观察方式 |
|---|---|---|
| 使用连续性 | 每周有效学习天数、连续学习天数 | `sessions` / `daily_plans` |
| 输出量 | 每日用户发言分钟数、日语字符数 | `turns` / `usage_records` |
| 纠错效果 | Retry 成功率、同类错误复发率 | `learning_events` |
| 纠错节奏 | 平均「问题识别 → 呈现」间隔轮数、单次呈现条数分布 | `detected_issues` |
| 词汇激活 | 被动词转主动使用的数量 | `USED_SPONTANEOUSLY` 事件 |
| 复习质量 | 到期项目完成率、召回成功率 | `review_queue` |
| 体验质量 | Turn 完成率、文字降级率、P50/P95 延迟 | 运行日志与指标 |
| 成本 | 每日/每周/月度供应商费用、每 turn LLM token 数 | `usage_records` |
| 基础设施余量 | Neon CU-hours 月度消耗、Railway 资源用量 | 供应商控制台 + 月度复核 |

---

# 2. 学习体验与交互模式

## 2.1 Conversation Mode｜自然对话

目标是训练连续表达与真实交流。Agent 像日本朋友一样先接住内容、继续追问，在一个自然段落结束后再给少量高价值反馈。

典型行为：

- 不因每个助词或变形错误打断对话。
- 复用近期学习词汇，但不显式提示"现在正在测试你"。
- 3–5 轮后给出不超过 3 项纠正。
- 纠正后要求用户用推荐表达重新说一次。
- 根据水平动态控制句长、词汇、敬体/常体和中文辅助量。

**实现约束（V1.1 新增）：** "3–5 轮后反馈"不是写在 prompt 里的建议，而是 Correction Scheduler 的确定性规则。模型每轮都识别问题并落库（`detected_issues`），但只有当程序在上下文中显式下达"本轮呈现以下问题"时才输出纠错卡。详见 §5.4。

示例：

```text
用户：昨日、友達と映画を見るました。
Agent：へえ、何の映画を見たんですか？面白かったですか？
        ← 问题已识别并落库，surfaced_at = NULL

（对话继续，达到呈现条件后）
今日のポイント：
「映画を見るました」→「映画を見ました」
では、昨日のことをもう一度自然に言ってみましょう。
        ← Scheduler 取出 pending 问题，模型渲染为纠错卡
```

## 2.2 Coach Mode｜精细纠错

目标是准确理解为什么错、怎样更自然以及不同表达的语感差异。适合写作修改、难点讲解和专项训练。

每条反馈建议包含：

- 用户原句；
- 推荐表达；
- 语法或用词原因；
- 更自然的替代表达；
- 正式度、关系和场景说明；
- 一次由用户完成的改写或造句。

Coach Mode 可以逐句处理，但仍应按重要性排序，避免一次输出过多解释。在 Coach Mode 下 Correction Scheduler 的呈现阈值设为 1 轮，即每轮立即呈现——**同一套机制，不同参数**，不需要第二条代码路径。

## 2.3 Challenge Mode｜全日语沉浸

目标是减少翻译依赖并建立日语思维。默认只使用日语，Agent 不主动给出中文答案。

- 学习者可发送"ヒント"获得日语提示。
- 第二次仍失败时给关键词或句型框架。
- 最后才允许简短中文解释。
- 题目难度应略高于当前稳定水平，但不能高到只能猜。
- 对话结束后仍保留少量纠错与 Retry。

## 2.4 Roleplay 与专项入口

Roleplay 不是第四种纠错策略，而是在三种模式上叠加的场景层。可覆盖：便利店、餐厅、酒店、电车、医院、电话预约、租房、公司会议、面试、邀请与拒绝等。

建议命令：

- `/talk`：Conversation Mode
- `/coach` 或 `/correct`：Coach Mode（亦可用于立即冲刷 pending 问题）
- `/challenge`：Challenge Mode
- `/roleplay`：选择场景与难度
- `/review`：到期复习
- `/vocab`：词汇召回与造句
- `/grammar`：专项语法训练
- `/listening`：由 TTS 生成短听力
- `/progress`：查看学习进度
- `/cost`：查看成本
- `/end`：结束并总结 session

日常使用不强制命令；普通消息由 Session Orchestrator 根据当前模式处理。

## 2.5 中文使用策略

| 学习阶段 | 默认语言策略 |
|---|---|
| Beginner | 日语问题 + 必要的简短中文释义 |
| Intermediate | 日语为主，语法解释可用中文 |
| Advanced | 95% 以上日语，仅复杂 nuance 使用中文 |

语言策略属于 Learner Profile 的偏好项，可由用户随时调整，也可由系统根据理解失败率建议调整。

## 2.6 首次水平评估

首次使用不只询问 JLPT 等级，而进行约 10 分钟 Placement Conversation，分别估计 Vocabulary、Grammar、Speaking、Comprehension、Naturalness 与 Response Fluency。系统保存的是维度化能力画像，例如"阅读 N3、口语 N4"，而不是单一 N 级标签。

---

# 3. Curriculum Engine：每日、每周与每月规划

## 3.1 固定骨架 + 动态内容

每日计划采用固定学习节奏，但内容由 Learner Model 动态选择：

| 模块 | 时间占比 | 目的 | 数据来源 |
|---|---:|---|---|
| 旧知识召回 | 15% | 对抗遗忘 | Error Bank / Vocabulary / Review Queue |
| 自然输入 | 20% | 接触真实日语 | 短对话、短文、听力材料 |
| 今日重点 | 20% | 推进长期路线 | Curriculum Roadmap |
| 输出练习 | 35% | 将知识转为能力 | Conversation / Roleplay / 表达任务 |
| 总结与复测 | 10% | 形成闭环 | 本日错误、新知识与 Retry |

25 分钟示例：3 分钟复习、5 分钟短输入、5 分钟核心表达、9 分钟连续输出、3 分钟总结与重述。

## 3.2 四个内容池

**Review Queue。** 最高优先级，包含最近错误、即将遗忘的词汇、学过但不会主动使用的语法与失败的召回项目。

**Learning Roadmap。** 保证课程有系统主线，避免每天只围绕偶然错误打转。例如 N4 → N3 可依次推进基础口语自动化、意图与观点、复杂连接、自然口语、社会与工作交流。

**Topic Rotation。** 轮换日常生活、日本旅行、社交、工作、自由话题和综合 Roleplay，防止能力只在熟悉主题中有效。

**Interest Pool。** 将 AI、科技、产品、旅行、宠物等个人兴趣嵌入练习，提高长期参与度和表达迁移价值。

## 3.3 Daily Planner 决策

候选项目可采用可解释的优先级：

```text
Priority = 0.30 × Forgetting Risk
         + 0.25 × Error Frequency
         + 0.20 × Roadmap Relevance
         + 0.15 × Real-world Utility
         + 0.10 × Activation Gap
         - Repetition Penalty
```

其中 Activation Gap 表示"认识但不会主动使用"的差距；Repetition Penalty 防止同一项目在短期内过度出现。V1 先使用透明规则，积累数据后再调整权重，不需要机器学习排序模型。

## 3.4 每日内容约束

- 新单词：5–8 个；
- 新表达：2–4 个；
- 核心新语法：最多 1 个；
- 高价值纠错：最多 3 个；
- Review 项目：2–5 个，以综合召回为主；
- 至少一次不带提示的 Output Challenge；
- 至少一次 Retry，验证用户能否立即修正。

Daily Plan 在当天第一次真正开始学习时 Lazy Generate，不在凌晨预生成。若当天没有学习，不产生 Planner 模型成本。**这条决策同时服务于 §7.4 的算力预算——凌晨预生成会在无人使用时唤醒数据库。**

## 3.5 Weekly Curriculum

每周围绕一个可观察能力目标组织不同场景，例如"能自然表达计划、意图和邀请"。系统选择 3–5 个关联语法或表达，在一周内通过不同话题重复使用；周末生成 Weekly Review，报告：完成情况、复发错误、激活词汇、掌握度变化和下周重点。

## 3.6 Monthly Benchmark

每四周使用难度相近、结构一致但内容不同的任务进行基准测试，比较：

- 连续表达时长与句子复杂度；
- 语法错误密度与同类错误复发率；
- 词汇多样性与主动词汇使用；
- Naturalness、Fluency 与中文辅助依赖；
- 听到问题后的响应时间；
- 同一能力目标在新场景中的迁移情况。

Monthly Benchmark 不应只由 LLM 给分。应同时保留可重算的客观事件，例如错误数、提示次数、Retry 成功、使用目标表达次数和停顿统计。

## 3.7 Review Queue 与 Mastery

V1 可从 1、3、7、14、30 天的简单间隔开始，并依据事件调整：

- `FAILED_RECALL` / 同类错误：降低 mastery，缩短间隔；
- 提示后正确：小幅提升；
- 无提示正确：正常提升；
- 在自然对话中主动使用：较大提升；
- 多场景稳定使用：标记为 `MASTERED`，但保留低频维护复习。

Mastery 是程序根据 Learning Events 计算的状态，不允许 LLM 直接随意写一个分数。

---

# 4. Telegram 文字与语音体验

## 4.1 消息组合

用户发送文字时，Agent 默认回复日文文本；需要时追加简短纠错卡。用户发送语音时，建议回复组合为：

1. 日语语音回复；
2. 对应日文 transcript；
3. 有必要时发送最多 3 项纠错（由 Correction Scheduler 决定是否本轮呈现）；
4. 中文解释仅按模式与水平出现。

语音与文字必须共享同一 Session、Memory 和 Curriculum 上下文，不能形成两套学习记录。

**语音条格式（V1.1 确认）：** Telegram `sendVoice` 原文要求音频为 *.OGG encoded with OPUS, or in .MP3 format, or in .M4A format*。MiniMax T2A 输出的 mp3 属于受支持格式，**可直接作为语音条发送，输出路径不需要转码**。不要为了"统一成 ogg"而引入不必要的出站转码。

**可选增强：** Bot API 10.1（2026-06）引入 Rich Messages，含 `RichBlockVoiceNote` 等结构化块。纠错卡用它渲染比手工拼 Markdown 更干净，且不易被用户输入中的特殊字符破坏。列为阶段 3 的可选项，不进入 V1 必做范围。

## 4.2 Session 生命周期

Telegram 没有显式会话边界，因此定义：

```text
首条学习消息 → SESSION_ACTIVE
连续交互 → 刷新 last_activity_at
30 分钟无活动或 /end → SESSION_CLOSED
关闭 → 生成摘要、学习事件与次日候选重点
```

新消息在较短间隔内复用当前 session；超过阈值时创建新 session。阈值配置化。

**Session 关闭的触发方式（V1.1 明确）：** 不使用定时轮询扫描超时 session。session 超时在下一次真正有消息进来时惰性判定，或由 §4.3 的单一定时器在预定时刻处理。理由同 §7.4——任何固定频率的数据库扫描都会持续唤醒 compute。

## 4.3 Reminder 与定时任务

**V1.1 重要修订：** V1.0 的"DB-backed tick + due jobs 轮询"会成为算力消耗的主因。若每分钟轮询一次 `outbox_jobs`，数据库永远不会进入 Neon 的 5 分钟空闲阈值，§7.4 的全部努力都会失效。

改为**持久化 + 进程内定时器**的组合：

```text
启动时      → 从 outbox_jobs 读取最近的 due_at，设置单个进程内定时器
任务触发时  → 唤醒、执行、写回状态、重新计算下一个 due_at、重设定时器
写入新任务时 → 若新任务早于当前定时器，重设定时器
进程重启    → 从 DB 重新水合，错过的任务按 due_at 补发（带唯一键去重）
```

数据库只在**任务真正到期时**被访问，而不是每个 tick 都访问。对个人使用场景，典型一天只有 1 次提醒任务 + 1 次学习 session，数据库活跃时间可控制在每天 40 分钟以内。

提醒示例：

> 今日まだ練習していませんよ。10分だけ話してみませんか？

Reminder Scheduler 只检查当天是否已学习，不提前生成 Daily Plan。提醒任务保存在数据库并带唯一键 `(learner_id, job_type, local_date)`，进程重启后可以恢复且不会重复发送。

**兜底：** 若未来任务类型变多、定时器逻辑变复杂，可退回低频轮询（≥15 分钟一次），但必须先确认 CU-hours 预算能覆盖——15 分钟轮询意味着数据库全天候不休眠。

## 4.4 Long Polling 决策

Telegram 提供 `getUpdates` Long Polling 与 Webhook 两种互斥的 update 获取方式。V1 使用 Long Polling，原因是：

- 本地开发无需公网 IP 或 TLS；
- Railway 只需主动访问 Telegram 与外部 API；
- 对个人单实例 Bot，Webhook 的扩展优势没有抵消其配置复杂度；
- grammY 对 Long Polling 支持成熟。

约束：V1 生产环境保持单个 Bot 消费实例；若未来水平扩展或改用 worker，再迁移到 Webhook + Queue。

**注意：** Long Polling 持续占用的是 Railway 的进程与出站网络，**不触及数据库**。因此它与 §7.4 的 Neon 休眠策略并不冲突——常驻的是计算进程，不是数据库连接。这一点在 V1.0 中被混为一谈。

---

# 5. 总体技术架构

## 5.1 架构形态

V1 采用 **Modular Monolith（模块化单体）**。物理上是一个 Node.js 进程，逻辑上按清晰职责分层，不把 Conversation、Evaluator、Planner 实现为每轮串行调用的多个 Agent。

```text
Telegram
   │
   ▼
Telegram Adapter ── Auth / Dedupe / Message Router
   │
   ▼
Session Orchestrator
   ├── Speech Service ────── Audio Normalizer / STT Adapter / TTS Adapter / Temp Audio
   ├── Tutor Service ─────── Conversation / Detection / Evaluation
   ├── Correction Scheduler ─ Pending issues / 呈现时机 / Retry 跟踪
   ├── Learning Engine ───── Daily Planner / Review / Mastery / Curriculum
   ├── Memory Service ────── Profile / Error Bank / Vocabulary / Events
   └── Usage Service ─────── Provider usage / cost / latency
   │
   ▼
Drizzle Repositories
   │
   ▼
Neon Postgres（按需唤醒，空闲时 scale-to-zero）

External Providers: Telegram · OpenAI STT · MiniMax TTS · Text LLM
Runtime: Railway Hobby, always-on, single instance
```

相对 V1.0，架构图新增两个显式组件：**Audio Normalizer**（承载 R3 的 remux 职责）与 **Correction Scheduler**（承载 R6 的纠错节奏职责）。二者在 V1.0 中都是隐式的，导致相应的设计缺口。

## 5.2 推荐技术栈

| 层 | 选择 | 说明 |
|---|---|---|
| Runtime | Node.js + TypeScript | 适合 API orchestration、事件与结构化 JSON |
| Telegram | grammY | 类型友好，支持 middleware、session 与 long polling；当前 1.45.1 |
| Validation | Zod | 校验配置、Provider 返回值与 LLM Structured Output |
| ORM | Drizzle ORM | 显式 schema、迁移清晰，支持 PostgreSQL |
| DB Driver | `pg`（node-postgres）+ 小连接池 | 保留交互式事务；`max: 2`、短 idle timeout 以允许 Neon 休眠。备选见 §7.4 |
| Database | Neon Postgres | 计算与长期记忆解耦，支持 scale-to-zero 与 branching |
| Hosting | Railway Hobby | 低运维、GitHub 部署、Secrets、日志和重启策略 |
| STT | OpenAI（`gpt-transcribe` / `whisper-1` 并列候选） | **必须由 Learner Japanese Benchmark 裁决**，见 §6.1 |
| TTS | MiniMax Speech 2.8 | Turbo 日常对话，HD 教学示范 |
| LLM | Provider Adapter | 选择支持 Structured Output 与 prompt caching 的文本模型 |
| Scheduling | 进程内定时器 + DB 持久化 | **不使用固定频率轮询**，理由见 §4.3 |
| Audio | FFmpeg（常规依赖，非 fallback） | 入站 OGG/Opus → WebM/Opus remux；出站 mp3 直传 |

**部署侧注意：** FFmpeg 现在是常规依赖，Railway 的 Nixpacks 需在 `nixpacks.toml` 或等效配置中显式声明，否则第一次部署才会暴露缺失。本地开发环境同样需要。

## 5.3 目录边界

```text
src/
  telegram/       bot, middleware, commands, message renderer
  sessions/       session lifecycle, orchestrator, state machine
  agent/          tutor policy, context builder, output schemas
  corrections/    pending issues, surfacing policy, retry tracking
  learning/       daily planner, curriculum, review, mastery
  memory/         profile, knowledge, learning events
  speech/         audio lifecycle, normalizer, STT/TTS contracts and providers
  db/             schema, migrations, repositories
  scheduler/      reminders, timer management, retries
  usage/          metering, cost calculation, budgets
  config/         validated environment configuration
  observability/  logs, metrics, correlation IDs
  app.ts
```

每个模块对外暴露稳定接口，不允许 Telegram handler 直接调用具体供应商 SDK 或直接拼接 SQL。

## 5.4 Tutor 的单次主调用

常规 turn 只做一次主要 LLM 调用。输入包括 Tutor Policy、Learner Profile、Today Plan、相关 Review Items、最近 8–12 个 turns、**Correction Scheduler 的呈现指令**与当前消息。

### 输入侧：呈现指令

Context Builder 在组装上下文时，由 Correction Scheduler 附加一段明确指令，二选一：

```text
surfacingDirective: { action: "HOLD" }
  → 模型正常对话，识别到的问题只落库，不在回复中提及

surfacingDirective: {
  action: "SURFACE",
  issues: [ { id, original, recommended, reason, importance }, ... ],
  requestRetry: true
}
  → 模型把这些问题渲染成纠错卡，并要求用户重说一次
```

**这是 V1.1 与 V1.0 最关键的行为差异。** V1.0 让模型自己判断该不该纠错，导致 §2.1 的"3–5 轮后反馈"无法被验收；V1.1 把节奏移到程序侧，模型只负责把被指定的内容表达得自然。

### 输出侧：结构化 schema

```json
{
  "reply": { "japanese": "...", "translation": null },
  "detectedIssues": [
    {
      "original": "映画を見るました",
      "recommended": "映画を見ました",
      "reason": "「見る」のマス形過去は「見ました」",
      "naturalAlternative": null,
      "knowledgeKey": "verb_masu_past",
      "importance": "high"
    }
  ],
  "correctionCard": null,
  "retryEvaluation": null,
  "learningEvents": [
    { "type": "USER_ERROR", "knowledgeKey": "verb_masu_past", "evidence": "..." }
  ],
  "tts": { "enabled": true, "mode": "conversation", "text": "..." },
  "session": { "continue": true }
}
```

字段职责：

- `detectedIssues` — **每轮都输出**，无论是否呈现。程序全部写入 `detected_issues` 表，`surfaced_at` 置空。这保证 Error Bank 不会因为"本轮不是反馈时机"而丢失证据。
- `correctionCard` — 仅当输入侧 `action = SURFACE` 时非空，内容是面向用户的渲染文本。
- `retryEvaluation` — 仅当上一轮请求了 Retry 时非空，判定用户本轮的重说是否成功，驱动 `RETRY_SUCCEEDED` 事件。
- `tts.text` — 只包含需要朗读的日语部分，不含中文解释（成本与体验双重考虑）。

Conversation、Detection、Evaluation 和 Memory Extraction 在一次 inference 中完成，以降低延迟与成本。Daily Planner、Session Summary 和 Monthly Benchmark 可以在明确边界处独立调用。

### Correction Scheduler 规则

程序侧决策，全部可配置、可单元测试：

```text
呈现条件（满足任一即 SURFACE）：
  - 自上次呈现以来的轮数 ≥ SURFACE_AFTER_TURNS（Conversation 默认 4，Coach 默认 1）
  - pending 中 importance=high 的条数 ≥ 2
  - 用户显式请求（/coach、/correct）
  - session 即将结束（/end 或超时前的总结）

呈现内容：
  - 按 importance × 知识项优先级排序，单次最多 3 条
  - 已呈现项标记 surfaced_at，进入 Retry 跟踪
  - 未入选项保留在 pending，可跨 session 累积
```

### Prompt Caching

Tutor Policy 与 Learner Profile Summary 在连续多轮中稳定不变，应作为可缓存前缀放在上下文最前端，动态内容（最近 turns、当前消息、呈现指令）置后。这是 §6.7 成本控制中最有效的单项措施。

---

# 6. Speech 架构与供应商策略

## 6.1 STT 选型：由 Benchmark 裁决，不预设默认

**V1.1 重要修订。** V1.0 直接把 `gpt-4o-transcribe` 定为默认，存在两个问题：

**其一，模型已被取代。** OpenAI 当前推荐的转写模型是 `gpt-transcribe`（$0.0045/min），`gpt-4o-transcribe`（$0.006/min）仍可用但不再是推荐项。`gpt-4o-mini-transcribe` 为 $0.003/min，`whisper-1` 为 $0.006/min。

**其二，也是更重要的——新模型的核心卖点与本产品目标相冲突。** `gpt-transcribe` 主打 unstructured context、keyword hints 与 multiple language hints，用来提升领域术语和 code-switching 的识别率。但这类上下文条件化本质上是让模型"按预期猜"，而本产品**恰恰需要它如实记录学习者说错的内容**。一个会把「映画を見るました」顺手转成「映画を見ました」的 STT，会让整个 Error Bank 静默失真，而且这种失真无法从下游发现。

因此 V1 的 STT 选型规则改为：

| 候选 | 单价 | 预期特点 | 定位 |
|---|---:|---|---|
| `gpt-transcribe` | $0.0045/min | LLM 式转写，抗幻觉强，但可能语义顺滑 | 候选 A |
| `whisper-1` | $0.006/min | 传统 ASR，不做语义补全，长静音易幻觉 | 候选 B |
| `gpt-4o-mini-transcribe` | $0.003/min | 成本下限参考 | 候选 C |

裁决标准是 §6.4 的 **Error Preservation Rate 优先于 WER**。成本差异（每月 $1.4 vs $2.0）小到不应影响决策。

**若最终选择 `gpt-transcribe`，必须关闭或严格限制 context/keyword hints**，并在 benchmark 中量化 hints 对错误保留率的损害（带 hints / 不带 hints 各跑一遍）。

**TTS：MiniMax `speech-2.8-turbo` / `speech-2.8-hd`。** Turbo 负责普通聊天；HD 负责发音示范、shadowing、重点句和听力材料。日语通过 `language_boost=Japanese` 等供应商能力进行配置。价格已复核：Turbo $60 / 1M characters，HD $100 / 1M characters。

**Adapter：** OpenAI、MiniMax 只是默认实现。接口层保留 Deepgram、ElevenLabs 或其他供应商的接入位置。

## 6.2 Provider 接口

```text
AudioNormalizer.normalize(input, targetFormats) → NormalizedAudio
  NormalizedAudio: path, format, container, codec, durationMs, transcoded: boolean

SpeechToTextProvider.supportedInputFormats → string[]
SpeechToTextProvider.transcribe(audio, options) → Transcript

Transcript:
  rawText, language, durationMs, confidence?, segments?,
  provider, model, usage

TextToSpeechProvider.outputFormat → string
TextToSpeechProvider.synthesize(text, voiceConfig) → AudioResult

AudioResult:
  bytes/path, format, durationMs?, timestamps?,
  provider, model, usage
```

**V1.1 新增 `supportedInputFormats` 与 `outputFormat`。** 格式协商必须由 Adapter 声明、由 Audio Normalizer 消费，而不是散落在调用点的硬编码假设——V1.0 正是因为把"OGG 直传"写死在流程里才产生了 R3 那个缺陷。换 STT 供应商时，格式适配应当自动跟随。

配置示例：

```text
STT_PROVIDER=openai
STT_MODEL=gpt-transcribe          # 或 whisper-1，由 benchmark 裁决
STT_CONTEXT_HINTS_ENABLED=false   # 默认关闭，见 §6.1
TTS_PROVIDER=minimax
TTS_MODEL_CONVERSATION=speech-2.8-turbo
TTS_MODEL_TEACHING=speech-2.8-hd
```

## 6.3 Raw 与 Normalized 必须分离

```text
raw_transcript:        昨日友達と映画を見るました
normalized_transcript: 昨日、友達と映画を見ました
```

Tutor 以 raw 为错误证据，以 normalized 辅助理解。任何标准化步骤都不能覆盖 raw；否则 Error Bank 会失真。

注意这里的 "normalized" 指**文本**标准化，与 §6.2 的 Audio Normalizer（音频容器转换）是两件不同的事，实现时不要混淆命名。

## 6.4 Learner Japanese Benchmark

上线前录制 30–50 条、后续扩充到 100 条的专用测试集，包含：

- 正确日语；
- 助词和动词变形错误；
- 长音、拗音和易混词；
- 中日英混合；
- 停顿、重复、自我修正；
- 日常手机录音环境与不同语速。

**核心指标：Error Preservation Rate** —— 学习者真实错误被原样保留的比例。普通 WER 作为参考指标，但当两者冲突时以 Error Preservation Rate 为准。

测试矩阵（V1.1 扩充）：

| 配置 | 目的 |
|---|---|
| `gpt-transcribe`，无 hints | 主候选基线 |
| `gpt-transcribe`，带 hints | 量化 hints 对错误保留的损害 |
| `whisper-1` | 传统 ASR 对照，验证是否更"诚实" |
| `gpt-4o-mini-transcribe` | 成本下限对照 |

**该 benchmark 应在阶段 2 完成后立即进行，不要推迟到阶段 6。** STT 选错会污染此前积累的全部学习数据，越晚发现代价越大——这是整个项目里返工成本最高的单点决策。

TTS 对比 MiniMax Turbo/HD 与至少一个备选供应商，评价日本母语感、mora/长音、数字日期、外来语、附和语气、长对话配音腔、延迟和成本。

## 6.5 STT 不等于发音评分

STT 正确识别一个词，只能说明系统猜到了内容，不能证明音高、音素、mora timing 或 pitch accent 正确。V1 可以评价语法、词汇、自然度、粗粒度流畅度和明显停顿；不得输出看似精确的"发音 8.7/10"。精确发音评估留给 V2 的声学模块。

## 6.6 为什么 V1 不使用 Realtime

Realtime 的核心价值是双向流式语音、VAD、打断和电话式体验。但 Telegram 的交互本身是"录音 → 发送 → 回复"的离散 turn：

- 无法充分利用用户打断和持续双向流；
- 会增加会话状态、流式连接、重连和成本控制复杂度；
- 不利于在每个 turn 后生成结构化纠错与 Learning Events；
- 异步链路更便于幂等重试和故障降级。

因此 V1 使用普通 HTTP STT/TTS；当 V3/V4 出现 Web 或电话式口语场景时再重新评估 Realtime。

## 6.7 成本基线与控制

**V1.1 重大修订。** V1.0 的成本分析几乎只覆盖 TTS 与 STT，而这两项恰恰是最便宜的部分；LLM 主调用才是月度成本的主导项，却未被建模。这导致 §12.4 的预算保护手段（关 HD、缩短 TTS 文本）作用于总成本不足三成的部分，杠杆放错了位置。

### 估算假设

每天一节 25 分钟课程、约 25 轮对话、每月 30 天。每轮 LLM 输入 3–6K tokens（Policy + Profile + Plan + Review + 8–12 轮历史 + 当前消息），输出 400–800 tokens（结构化 JSON）。

### 月度成本估算

| 项 | 估算 | 依据 |
|---|---:|---|
| LLM 主调用 | **$11–27** | 750 次调用；按 $3 / $15 per M tokens 估 |
| MiniMax TTS | $4–8 | 60K–110K 日文字符；80% Turbo + 20% HD |
| OpenAI STT | $1.4–2.0 | 300–450 分钟音频 |
| Railway Hobby | $5–10 | $5 订阅含 $5 额度，常驻进程大概率略超 |
| Neon | $0 | 前提是 §7.4 的算力策略生效 |
| **合计** | **$21–47** | LLM 占 40–60% |

参考：MiniMax 若每月生成 100K 字符，全部 Turbo 约 $6、全部 HD 约 $10；按 80% Turbo + 20% HD 约 $6.8。此项 V1.0 估算准确，予以保留。

OpenAI 转写当前按分钟计价（`gpt-transcribe` $0.0045/min），但价格与计价方式都可能变化。系统必须保存供应商返回的 usage，并用可版本化价目表计算估算成本，不在代码中写死单价。

### 成本优化优先级（按实际杠杆重排）

1. **Prompt caching** —— Tutor Policy 与 Profile 作为稳定前缀缓存，直接作用于最大的成本项；
2. **控制上下文长度** —— 最近 turns 取 8–12 轮而非全量；Review Items 按相关性裁剪；
3. 常规 turn 只做一次主 LLM 调用；
4. Daily Plan 按需生成；
5. 普通对话使用 Turbo，仅关键教学使用 HD；
6. 重试复用已持久化输出，不重复调用 LLM/TTS；
7. 对 TTS 文本做长度约束，避免把完整中文解释也合成为语音；
8. 设每日和月度预算软阈值，超限时提醒并可降级为文字。

个人使用初期先设一个宽松月预算，7 天试运行后以真实 `usage_records` 校准。

---

# 7. 核心数据模型

## 7.1 三层 Memory

**Working Memory：** 当前 session 最近 8–12 个 turns，负责对话连续性。

**Learning Memory：** Vocabulary、Grammar、Error Patterns、Mastery、Review Queue、Goals，是长期产品资产。

**Profile Summary：** 短小稳定的能力、目标、偏好和薄弱点摘要，每轮可进入模型上下文。因其稳定性，它同时是 prompt cache 前缀的理想成员（§5.4）。

完整历史不会全部回填给 LLM；上下文由 Context Builder 按相关性与 token budget 选择。

## 7.2 核心表

| 表 | 关键字段 | 主要职责与约束 |
|---|---|---|
| `learner_profiles` | `id`, `telegram_user_id`, levels, goals, preferences | Telegram ID 唯一；保存能力画像与语言策略 |
| `sessions` | `id`, `learner_id`, `mode`, `topic`, status, timestamps, summary | 管理 session 生命周期 |
| `turns` | `id`, `session_id`, `telegram_message_id`, input_type, raw/normalized/reply, status | 消息级事实；message ID 唯一 |
| `detected_issues` | `id`, `turn_id`, `session_id`, `knowledge_item_id`, original, recommended, reason, importance, `surfaced_at`, `retry_status` | **V1.1 新增。** 承载纠错的 pending 缓冲；`surfaced_at IS NULL` 即待呈现 |
| `knowledge_items` | `id`, `type`, `key`, canonical_form, metadata, mastery | 统一承载词汇、语法、表达、错误模式 |
| `learning_events` | `id`, `turn_id`, `knowledge_item_id`, event_type, evidence | 可审计、可重算的学习事实 |
| `review_queue` | `knowledge_item_id`, next_review_at, interval, priority, state | 每个 learner/item 唯一 |
| `daily_plans` | `id`, `learner_id`, plan_date, goal, status, source_snapshot | learner/date 唯一，支持复现生成依据 |
| `daily_plan_items` | `plan_id`, type, knowledge_item_id, target_count, result | Review/New/Challenge 明细 |
| `telegram_updates` | `update_id`, received_at, status, attempts, error | `update_id` 唯一，幂等入口 |
| `usage_records` | provider, model, operation, units, estimated_cost, latency, cache_hit | 成本与性能审计 |
| `outbox_jobs` | job_type, dedupe_key, due_at, payload, status, attempts | 提醒、重试和延迟任务；由进程内定时器消费（§4.3） |

`detected_issues` 与 `learning_events` 的分工：前者是**面向用户呈现**的纠错条目及其生命周期（待呈现 → 已呈现 → Retry 结果），后者是**面向掌握度计算**的不可变事实流。一个问题被识别时同时写入两者，但后续状态变化只发生在 `detected_issues`。

## 7.3 Learning Event 类型

```text
INTRODUCED
REVIEWED
USER_ERROR
USER_CORRECT
RETRY_SUCCEEDED
FAILED_RECALL
USED_WITH_HINT
USED_SPONTANEOUSLY
MASTERED
```

事件包含 evidence、来源 turn、模式和难度。Mastery Engine 从事件计算当前状态，允许未来更换算法后重算。

## 7.4 数据库连接、算力预算与迁移

**V1.1 重大修订。** V1.0 中有一处内部矛盾：§11.1 要求 Railway always-on 常驻实例，§11.2 又把"Neon 空闲可 scale-to-zero"列为选型理由。这两件事只有在**应用不持有长连接、且没有高频后台查询**时才同时成立。

### 算力约束

Neon Free 为 **100 CU-hours / project / 月**，官方说明相当于 0.25 CU 运行 400 小时；scale-to-zero 在闲置 5 分钟后**强制生效且不可关闭**。若应用常驻并持有 pooled 长连接：

```text
730 h/月 × 0.25 CU = 182.5 CU-h   vs   额度 100 CU-h
100 ÷ 0.25 = 400 h ≈ 每月第 17 天 compute 被 suspend
```

即数据库每月中旬停摆——而这正是 §10.4 试图保护的那份长期学习资产。

### V1 策略

**驱动选择：`pg`（node-postgres）+ 小连接池。** 保留完整的交互式事务能力（§8.1 第 11 步需要读-算-写的原子性）。

```text
pool.max = 2
pool.idleTimeoutMillis = 15000     # 15 秒后释放空闲连接
connectionTimeoutMillis = 10000    # 覆盖 Neon 冷启动
```

**配套约束（缺一不可）：**

- Scheduler 使用进程内定时器，不做固定频率 DB 轮询（§4.3）；
- Session 超时惰性判定，不做定时扫描（§4.2）；
- Daily Plan 惰性生成，不做凌晨预生成（§3.4）；
- Long Polling 只连 Telegram，不触及数据库（§4.4）。

四条合起来，数据库的活跃时间约等于"用户实际学习时间 + 每次活动后的 5 分钟休眠延迟"。典型一天：25 分钟 session + 1 次提醒 + 两段 5 分钟延迟 ≈ 40 分钟/天 ≈ 20 小时/月 ≈ **5 CU-hours/月**，相对 100 的额度有 20 倍余量。

### 备选方案

若实测 CU-hours 仍超预算，或希望彻底摆脱连接管理：改用 `@neondatabase/serverless` 的 **HTTP driver**（Drizzle 的 `neon-http`）。请求完全无状态，compute 必然能休眠。

**代价必须提前知道：** `neon-http` **不支持交互式事务**，Drizzle 对回调式 `db.transaction()` 会直接抛出 `No transactions support in neon-http driver`。只支持"一次性发送一批语句"的非交互式事务（`db.batch([...])`）。

对本系统而言这基本够用——§8.1 第 11 步的写入集合（更新 turn、插入 N 条 learning events、插入 detected issues、更新 review queue、更新 session）在执行前就完全已知。唯一需要留意的是 Mastery 重算这类"先读后写"的逻辑，需拆成「批外读 → 计算 → 批内条件写」。单用户单进程场景下不存在并发争用，这样做是安全的。

### 连接串与迁移

- `DATABASE_URL`：应用运行时连接。单实例长驻进程使用 direct connection 即可，PgBouncer 池化对本工作负载不带来收益，反而使空闲行为更难预测。
- `DATABASE_URL_DIRECT`：Drizzle migration、`pg_dump` 与管理任务使用。
- 迁移在受控 CI 步骤中执行；应用启动不做不可逆 schema 变更。
- 所有写入使用数据库时间与 UTC，展示时转换为用户时区。
- 生产从 Day 1 使用 Postgres；SQLite 仅可用于独立单元测试或临时本地测试。

### 监控

Neon 月度 CU-hours 消耗纳入 §12.2 的观测项，**上线首月必须在第 7 天和第 15 天各复核一次**。这是唯一会导致"服务在月中静默死亡"的失效模式，且不会有任何应用层告警自动触发。

存储侧：Free 提供 0.5 GB/project。纯文本的学习事件与转写记录，单用户一年也远达不到该量级，不构成约束。

---

# 8. 完整 Voice Turn Pipeline

## 8.1 正常链路

```text
1.  Telegram Long Polling 收到 update
2.  校验 ALLOWED_TELEGRAM_USER_ID
3.  以 update_id / message_id 去重并创建 turn
4.  下载 OGG/Opus，校验类型、大小（≤25MB）、时长
5.  保存到唯一临时路径
6.  Audio Normalizer：OGG/Opus → WebM/Opus remux（换容器，不重编码）★
7.  OpenAI STT → raw transcript + usage
8.  单独生成 normalized transcript（不覆盖 raw）
9.  Correction Scheduler 判定本轮 HOLD 或 SURFACE，产出呈现指令 ★
10. Context Builder 加载 Profile、Daily Plan、Review Items、Recent Turns、呈现指令
11. Tutor LLM 输出经 Zod 校验的 reply / detectedIssues / correctionCard / events / tts
12. 在数据库事务中持久化输出、detected issues、learning events 与状态
13. MiniMax Turbo 或 HD 合成语音（mp3）
14. 发送文字与 Telegram voice reply（mp3 直传，无需转码）★
15. 写入 usage、latency 与 provider result
16. 删除用户与 TTS 临时音频
17. 将 turn 标记为 COMPLETED
```

★ 标记为 V1.1 相对 V1.0 的变化点。

**关于第 6 步：** OpenAI 转写 API 官方支持格式为 `mp3`、`mp4`、`mpeg`、`mpga`、`m4a`、`wav`、`webm`，**不含 ogg**；而 Telegram 语音条正是 OGG/Opus。因此 V1.0 阶段 2 验收里的"OGG 可直接送入 STT"不成立。

好在代价极低——Opus 码流可以原样封进 WebM 容器：

```bash
ffmpeg -i input.oga -c:a copy output.webm
```

纯换容器、不重编码，耗时数十毫秒，无音质损失，也不会引入任何可能改变识别结果的信号处理。**不要用 `-c:a libmp3lame` 之类的重编码方案**，那会在学习者本就不标准的发音上再叠一层有损失真，直接伤害 Error Preservation。

（实践中 `.ogg` 有时能被接口接受，但那属于未公开行为，不应让关键路径依赖它。）

**关于第 14 步：** Telegram `sendVoice` 接受 .OGG/OPUS、.MP3 或 .M4A，MiniMax 输出的 mp3 属于受支持格式，可直接发送为语音条。出站路径**不需要** FFmpeg。

## 8.2 可恢复状态机

```text
RECEIVED → AUDIO_READY → AUDIO_NORMALIZED → STT_DONE → LLM_DONE → PERSISTED
         → TEXT_SENT → VOICE_SENT → COMPLETED
```

`AUDIO_NORMALIZED` 为 V1.1 新增状态，使 remux 失败可与下载失败、STT 失败区分开来并独立重试。

每一步保存稳定结果和 provider request ID。重试从最后成功状态继续：例如 TTS 发送失败时复用已持久化的日文回复，不重新调用 LLM；Telegram 重复 update 只返回已有处理结果或忽略。

## 8.3 文件生命周期

```text
/tmp/japanese-agent/<turn-id>/input.oga     ← Telegram 原始下载（OGG/Opus）
/tmp/japanese-agent/<turn-id>/input.webm    ← remux 结果，送 STT
/tmp/japanese-agent/<turn-id>/reply.mp3     ← MiniMax 输出，直接发送
```

使用随机且不可猜测的 turn ID；限制目录权限；成功、失败和进程启动时均清理过期文件。数据库只保留 transcript、时长、模型和 usage，默认不保留原始音频。

注意 remux 会使单个 turn 的临时占用翻倍（原始 + 转换后），需纳入 Railway 磁盘与清理逻辑的考虑——虽然对 30 秒语音而言绝对量极小。

---

# 9. 容错、幂等与一致性

## 9.1 故障降级

| 故障 | 用户体验 | 系统行为 |
|---|---|---|
| 音频 remux 失败 | 提示重新发送或改用文字 | 记录原始格式与 FFmpeg 错误；不进入 STT；可独立重试 |
| STT 超时/失败 | 提示重新发送或改用文字 | 不生成错误评价；记录失败与重试次数 |
| LLM 失败 | 简短说明暂时无法完成本轮 | 有限重试；不制造伪造学习事件 |
| Structured Output 无效 | 用户感知为短暂延迟 | 进行一次 schema repair/retry，仍失败则降级 |
| TTS 失败 | 正常发送日文文字 | 将 `voice_status=FAILED`，可后台重试或放弃 |
| Planner 失败 | 继续自由对话或复用安全的既有计划 | 不阻塞日常聊天 |
| Correction Scheduler 异常 | 对话正常，本轮不呈现纠错 | pending 问题保留在库中，下轮重新评估；绝不因此丢弃已识别问题 |
| Memory 写入失败 | 明确提示本轮记录可能未保存 | 不宣称完成；避免重复外部调用 |
| Neon 冷启动 | 首条消息略慢（约 0.5–1 秒） | 超时、重连与连接池参数受控 |
| **Neon compute 额度耗尽** | 服务不可用，需人工介入 | 连接持续失败；应作为独立告警类别，不与冷启动混淆（§7.4） |
| Railway 重启 | 短暂中断后自动恢复 | 从 DB 状态继续，清理遗留临时文件，重建定时器 |

## 9.2 幂等策略

- `telegram_updates.update_id` 唯一；
- `turns.telegram_message_id` 唯一；
- Learning Event 使用确定性 dedupe key；
- Detected Issue 使用 `(turn_id, knowledge_key, original)` 去重，避免重试导致同一问题重复入队；
- Reminder 使用 `(learner_id, job_type, local_date)` 唯一；
- Provider 调用保存 request ID 与 result hash；
- Outbound 消息保存 Telegram 返回的 message ID；
- 只有数据库事务成功后才推进状态机。

## 9.3 超时与重试

仅对网络超时、429 和明确可重试的 5xx 做指数退避与随机抖动。校验失败、权限错误、超限和无效音频不盲目重试。每类 provider 设独立 timeout、最大尝试次数与熔断指标。

FFmpeg 失败属于确定性失败，不做重试（除非是磁盘临时性错误）。

---

# 10. 安全、隐私与备份

## 10.1 访问控制

所有 update 的第一道业务校验为：

```text
telegram_user_id == ALLOWED_TELEGRAM_USER_ID
```

不匹配时不调用任何 AI 供应商，也不返回包含系统信息的错误。未来多用户化时替换为正式身份与权限模型。

## 10.2 Secrets 与网络

- `BOT_TOKEN`、数据库连接、OpenAI、MiniMax 与 LLM 密钥只存 Railway Secrets。
- 日志中屏蔽 token、连接串、音频 URL 和完整敏感文本。
- Railway 不保存持久化业务文件；无需 Volume。
- Long Polling 不需要为 Telegram 暴露公网 Bot webhook。
- 若提供 health endpoint，只返回最小状态，不暴露配置或用户数据。**health check 不得查询数据库**——否则平台探针会持续唤醒 Neon compute，使 §7.4 失效。

最后一条是容易被忽略的陷阱：常见的 `/health` 实现习惯性带一条 `SELECT 1`，若平台每 30 秒探测一次，数据库将全天候不休眠。

## 10.3 数据最小化

- 原始语音与生成音频默认处理后删除（含 remux 中间产物）。
- 只保存实现学习目标所需的 transcript、纠错证据和统计。
- 提供 `/forget` 或管理脚本以删除 session、turn 或完整 learner 数据。
- 明确区分产品日志与学习内容；生产日志避免输出完整对话。

## 10.4 备份与恢复

Neon Free 的 point-in-time restore 窗口为 **6 小时上限、1 GB 变更量上限**（V1.0 只笼统称"有限窗口"）。这个窗口远小于"周末发现问题、周一处理"的现实节奏，**不能**作为灾备手段。

因此调整为：

- **V1 上线即启用独立备份**，而非 V1.0 所说的"累积有价值记录后再做"。6 小时窗口意味着任何隔夜发现的问题都已无法通过 Neon 自身恢复；
- 通过 direct connection 每晚执行加密 `pg_dump` 到 S3/R2 等独立对象存储；
- 保留 7 个 daily、4 个 weekly、6 个 monthly 备份；
- 每季度执行一次恢复演练并记录 RPO/RTO；
- 备份不包含临时音频。

备份任务由 §4.3 的定时器体系驱动，每晚一次；其数据库访问已计入 §7.4 的算力估算。

目标：Railway Service 被删除后，只需重新配置 Secrets 和代码即可恢复；Neon 数据损坏时可由独立备份恢复长期学习记忆。

---

# 11. 部署与无状态计算

## 11.1 生产拓扑

```text
GitHub main
   │
   ├── CI: lint / typecheck / test / build / migration check
   ▼
Railway Hobby — always-on, single instance（含 FFmpeg）
   │
   ├── Telegram getUpdates      ← 持续出站，不触及 DB
   ├── OpenAI STT
   ├── MiniMax TTS
   ├── Text LLM Provider
   └── Neon Postgres            ← 按需唤醒，空闲即休眠

Persistent business state: Neon only
Ephemeral files: Railway /tmp only
```

Railway Hobby 基础订阅为 $5/月，费用抵扣资源使用；超出部分按 RAM $10/GB·月、vCPU $20/vCPU·月、egress $0.05/GB 计费。一个常驻 Node 进程叠加偶发的 FFmpeg 调用，实际月账单预期落在 **$5–10** 区间，而非 V1.0 暗示的固定 $5。上线一周后应根据实际 CPU、内存和网络用量复核。

因为 Long Polling 持续进行 outbound 请求，生产服务应配置为 always-on，不以 serverless 休眠作为节省成本的手段。

**构建配置：** FFmpeg 需在 Nixpacks 配置中显式声明为系统依赖。这属于阶段 2 的部署验收项。

## 11.2 为什么是 Railway + Neon

Railway 负责可丢弃计算，Neon 负责长期学习资产。这样：

- 重新部署或删除 Railway Service 不影响 Learner Memory；
- 将来迁移 Fly.io、VPS 或其他运行平台时无需搬数据库文件；
- 本地开发与生产都使用 Postgres 语义；
- 未来多实例或多用户时不需先迁离 SQLite。

**关于 scale-to-zero 的准确表述（V1.1 修正）：** Neon 空闲时可 scale-to-zero，但这**不是自动获得的**——它要求应用不持有长连接、不做高频后台查询、health check 不打数据库。V1.0 把它当作既定收益，实际上它是一组设计约束的结果。这些约束已在 §7.4 集中列出。冷启动延迟（约 0.5–1 秒）相对 STT/LLM/TTS 的总延迟可接受。

## 11.3 环境与分支

最低环境：

- `local/test`：测试 Telegram Bot，Neon dev branch 或隔离数据库；
- `production`：正式 Telegram Bot，Neon main/production branch；
- 迁移必须先在 dev 验证，再进入 production。

注意 Neon Free 的 100 CU-hours 是 **per project** 配额，dev branch 的计算消耗计入同一项目。开发期频繁跑测试会占用额度，必要时为 dev 单开一个 project。

## 11.4 CI/CD Gate

```text
push / pull request
  → lint
  → typecheck
  → unit tests
  → integration tests
  → migration dry run / schema check
  → build
  → deploy Railway
  → smoke test
```

生产迁移使用 direct connection。高风险迁移要求先做备份、向后兼容发布，再删除旧字段。

---

# 12. 可观测性与成本追踪

## 12.1 结构化日志

每个 update/turn 生成 correlation ID，记录阶段、耗时、provider、model、attempt、status 和错误类别。日志不记录密钥或完整音频；对原始学习内容采取默认脱敏/截断。

## 12.2 关键指标

- update 接收与完成率；
- **remux**、STT、LLM、TTS P50/P95 latency；
- provider timeout、429、5xx 与 schema failure；
- duplicate update 命中数；
- TTS → text fallback 比例；
- DB transaction/retry 情况；
- session 完成率、Retry 成功率、review recall rate；
- **纠错节奏：识别 → 呈现的平均间隔轮数、单次呈现条数、pending 积压量**；
- 每 provider、model、operation 的日/周/月成本；
- **每 turn LLM input/output tokens 与 prompt cache 命中率**；
- **Neon 月度 CU-hours 消耗与剩余额度**（手工或脚本采集，上线首月加密复核）。

后三项为 V1.1 新增，分别对应 R6、R7、R1 三处修订的验证需要。

## 12.3 Usage Record

```text
provider, model, operation
input_tokens, output_tokens, cached_input_tokens
audio_input_seconds, audio_output_seconds
tts_characters
provider_reported_units
estimated_cost, currency, pricing_version
latency_ms, success, error_code
```

`cached_input_tokens` 为 V1.1 新增，用于验证 prompt caching 是否真正生效——这是最大成本项的主要控制手段，必须可观测。

价目表必须带 `effective_from` 和版本；历史成本使用调用当时的价格计算，不用最新价格回写。`/cost` 显示今日、本周、本月总额及各供应商占比。

## 12.4 预算保护

按 §6.7 重估后的成本结构，保护措施优先作用于 LLM：

- 每日软阈值：达到 80% 时提醒；
- 达到硬阈值时的降级顺序：**先缩减上下文轮数与 Review Items → 再停用 HD → 再缩短 TTS → 最后改为纯文字**；
- 单 turn 限制：输入 token 上限、音频时长、TTS 字符数与模型最大输出；
- 异常重试受总预算和 attempts 限制；
- 成本异常与调用量突增触发告警。

V1.0 的降级顺序（先关 HD、先缩 TTS）作用于总成本不足三成的部分，效果有限，故调整次序。

---

# 13. 路线图

## V1 — Telegram Tutor

- 文字与语音 turn；
- Conversation / Coach / Challenge；
- OpenAI STT（模型经 benchmark 裁决）+ MiniMax Turbo/HD；
- 延迟纠错（Correction Scheduler 驱动）、Retry、Session Summary；
- Learner Profile、Error Bank、Vocabulary、Learning Events；
- Daily Plan、基础 Review Queue；
- Long Polling、Neon、Railway、幂等、文字降级；
- Usage 与成本追踪、算力预算监控。

## V1.5 — Learning Engine

- 更完整的 spaced repetition 与 mastery；
- Weekly Review；
- Adaptive Difficulty；
- Vocabulary Activation；
- Error Recurrence 分析；
- 更稳定的 Curriculum Roadmap 与月度 Benchmark；
- Correction Scheduler 策略调优（基于 §12.2 的节奏指标）。

## V2 — Pronunciation Coach

- phoneme、mora timing、长音与促音分析；
- pitch accent 参考与不确定性表达；
- shadowing、分段播放与波形/时间戳；
- 按用户明确同意选择性保存练习音频；
- 独立声学评估，禁止用 STT confidence 代替。

注意 V2 需要保留原始音频，届时 §10.3 的数据最小化策略与 Railway 无状态假设都需重新设计（需引入对象存储）。

## V3 — Web / Telegram Mini App

- Progress Dashboard；
- Vocabulary / Error Bank 浏览器；
- Review 日历和趋势图；
- 音频回放、字幕和 Shadowing UI；
- 仍复用同一后端 Memory 与 Learning Engine。

## V4 — Multi-user Product

- 正式身份、租户隔离与数据导出/删除；
- Webhook、Queue、Worker、对象存储；
- 配额、订阅、支付与运营后台；
- 多实例伸缩、限流、SLA 与合规治理；
- Provider 路由、按用户预算和区域配置。

多用户化时 §7.4 的算力策略需整体重做——按需唤醒的假设建立在"单用户每天只活跃一段时间"之上。

---

# 14. 开发阶段与阶段验收

## 阶段 1：工程骨架与数据基础

交付：TypeScript 项目、grammY Long Polling、配置校验、Drizzle schema、Neon dev/production、日志与 CI 基线。

验收：

- 未授权 Telegram User ID 不触发外部调用；
- 文本 echo/smoke 流程在本地与 Railway 均可运行；
- schema 可从空数据库完整迁移；
- Secrets 不进入 repo 或日志；
- 重复 update 只创建一条 `telegram_updates` 记录；
- **空闲 10 分钟后 Neon compute 进入 idle 状态**（在控制台确认，这是 R1 全部策略的第一个可验证信号）。

## 阶段 2：最小语音纵向闭环

交付：Telegram voice 下载、Audio Normalizer、OpenAI STT、最小 Tutor LLM、MiniMax TTS、语音与文字回复、临时文件清理、usage 记录。

验收：

- Telegram 发送一条不超过 30 秒的日语语音，可收到日语语音回复和 transcript；
- **OGG/Opus 经 `-c:a copy` remux 为 WebM 后送入 STT，全程无重编码**；
- **MiniMax 输出的 mp3 直接经 `sendVoice` 发送并在客户端显示为语音条**（非音频文件）；
- FFmpeg 在 Railway 构建产物中可用；
- TTS 故障时仍收到文字回复；
- 临时音频（含 remux 中间产物）在完成或失败后被清理；
- 同一 update 重试不重复调用 LLM/TTS。

## 阶段 2.5：STT 选型裁决（V1.1 新增，前置于长期记忆）

交付：Learner Japanese Benchmark 数据集（首批 30–50 条）、四组配置的对比报告、STT 模型最终决定。

验收：

- 数据集覆盖正确句、助词/变形错误、中日英混合、停顿与自我修正、手机噪声；
- 产出各配置的 **Error Preservation Rate** 与 WER 对照表；
- 明确记录 `gpt-transcribe` 带/不带 hints 的错误保留率差异；
- 选定模型并在配置中固化，记录决策依据。

**该阶段必须在阶段 4 之前完成。** 一旦开始积累真实学习数据，更换 STT 就意味着此前的 Error Bank 全部可疑——这是项目中返工成本最高的决策点。

## 阶段 3：Tutor 行为与三种模式

交付：Tutor Policy、Structured Output、Conversation/Coach/Challenge、Correction Scheduler、纠错卡、Retry、Roleplay 基础场景。

验收：

- Conversation 连续 3–5 轮不因低价值错误频繁打断；
- **HOLD 期间识别到的问题全部落入 `detected_issues` 且 `surfaced_at` 为空**（即不呈现 ≠ 不记录）；
- **呈现时机由 Correction Scheduler 决定，可通过修改配置改变节奏且无需改动 prompt**；
- 每段最多 3 项重点纠错；
- Coach 输出原句、推荐句、原因、自然表达与练习；
- Challenge 默认全日语，按层级提供提示；
- Structured Output 校验失败可恢复且不会写入畸形事件。

## 阶段 4：长期记忆与 Curriculum

交付：Learner Profile、Knowledge Items、Learning Events、Error Bank、Vocabulary、Review Queue、Daily Planner、Session Summary。

验收：

- 某次真实错误在后续 Daily Plan 或对话中被再次测试；
- Retry 结果形成独立事件并改变 mastery；
- 每日计划满足新知识和纠错上限；
- 同一天重复打开复用同一 Daily Plan；
- Planner 失败时仍可进入自由对话；
- `/progress` 能展示可追溯的最近进展。

## 阶段 5：可靠性、部署与灾备

交付：可恢复 turn 状态机、outbox jobs 与定时器体系、重试/超时、Railway production、Neon backup、成本阈值和基础告警。

验收：

- 在 remux、STT、LLM、TTS、DB 各自模拟故障时符合降级矩阵；
- Railway 重启后不会重复回复已完成 update，且定时器正确重建；
- 删除并重建 Railway Service 后可通过 Secrets 接回原 Learner Memory；
- 完成一次备份与恢复演练；
- `/cost` 与供应商账单抽样误差在可解释范围内；
- **连续运行 7 天后核对 Neon CU-hours 消耗，外推月度值不超过额度的 30%**。

## 阶段 6：质量基准与个人试运行

交付：TTS A/B、benchmark 数据集扩充至 100 条、7–14 天个人试运行报告、缺陷清单与 V1 发布结论。

验收：

- 选定固定日语音色并记录 MiniMax Turbo/HD 使用规则；
- 连续 7 天无不可恢复的重复学习记录或记忆丢失；
- 典型 ≤30 秒语音 turn 的目标 P95 完成时间不超过 25 秒（外部供应商异常除外，作为目标而非 SLA）；
- 文本 turn 目标 P95 不超过 8 秒；
- 每日计划至少两次正确复用历史错误或词汇；
- 用户确认 Conversation 的纠错节奏不会破坏自然交流；
- **月度成本外推值落在 §6.7 估算区间内，prompt cache 命中率符合预期**。

---

# 15. V1 总体验收标准

## 15.1 功能

- 文字、语音、三种模式、Daily Plan、Review、Progress、Cost 全部可用；
- Voice Turn 完整执行 remux → STT → Tutor → TTS；
- 每个 session 可结束并产生摘要；
- 长期 Memory 会影响未来课程，而不是仅用于展示。

## 15.2 学习行为

- 能区分 Grammar、Naturalness、Fluency；
- **能延迟纠错且要求 Retry，且该节奏由程序控制、可配置、可测试**；
- 延迟期间识别到的问题不丢失；
- 能限制每日新知识与重点纠错量；
- 能把旧错误隐藏进新场景进行复测；
- 不把 STT 结果冒充精确发音评分。

## 15.3 可靠性

- Telegram update 与学习事件均具幂等约束；
- TTS 失败不阻塞文字学习；
- Provider 输出均经过 schema 校验；
- 临时文件可在正常、异常和重启后清理；
- Railway 可重建，Neon 数据不受影响；
- **基础设施额度可支撑连续整月运行**。

## 15.4 安全与数据

- 仅允许白名单用户；
- Secrets、连接串和 token 不出现在代码与日志；
- 原始音频默认不长期保存；
- 数据可导出、删除并从备份恢复；
- 独立备份自 Day 1 生效，不依赖 Neon 的 6 小时恢复窗口。

## 15.5 成本

- 每次 STT、LLM、TTS 调用均产生 usage record；
- `/cost` 可按日/周/月与 provider 聚合；
- 达到预算阈值可按 §12.4 顺序降级；
- 上线 7 天后形成基于实际使用的月成本预测。

---

# 16. 风险与待验证假设

| 风险 | 影响 | V1 应对 |
|---|---|---|
| **STT 自动修正学习者错误** | Error Bank 静默失真，且下游无法察觉 | 专用 benchmark 前置到阶段 2.5；保留 raw；默认关闭 context hints；以 Error Preservation Rate 选型 |
| **Neon CU-hours 耗尽致月中停摆** | 服务不可用，长期资产不可访问 | §7.4 四项设计约束；health check 不打库；首月两次人工复核 |
| **LLM 成本超预期** | 月账单失控 | prompt caching；上下文长度上限；按 §12.4 顺序降级 |
| TTS 日语听感不自然 | 错误模仿、长期流失 | 固定日本母语感音色；Turbo/HD/备选 A/B |
| LLM 纠错过多或时机错乱 | 对话体验破碎 | 纠错节奏移出 prompt，由 Correction Scheduler 确定性控制 |
| Memory 逐渐膨胀 | 成本、上下文噪声 | 三层 Memory；按相关性取数；不回填完整历史 |
| 供应商价格与模型变更 | 月成本失控、配置失效 | 价目版本、usage 追踪、预算阈值、Provider Adapter；模型 ID 不硬编码于业务逻辑 |
| Neon Free 恢复窗口仅 6 小时 | 隔夜发现的问题已无法自愈 | Day 1 启用独立加密 `pg_dump` 与恢复演练 |
| Long Polling 单实例中断 | 短时不可用 | Railway 重启策略；状态在 Neon；未来再迁 Webhook/Queue |
| LLM 评价漂移 | 分数不可比 | 保存客观事件与 prompt/model 版本；月度任务固定结构 |
| FFmpeg 缺失或版本差异 | 语音链路完全不可用 | 构建期显式声明依赖；阶段 2 验收覆盖；启动时自检 |

前三项为 V1.1 提升至最高优先级的风险，均为"静默失效"类型——不会立刻报错，但会在数周后以数据污染或服务中断的形式暴露。

---

# 17. 配置清单

```text
# Telegram
TELEGRAM_BOT_TOKEN
ALLOWED_TELEGRAM_USER_ID

# Database
DATABASE_URL                        # 运行时；direct connection
DATABASE_URL_DIRECT                 # 迁移与 pg_dump
DB_POOL_MAX=2                       # 见 §7.4
DB_POOL_IDLE_TIMEOUT_MS=15000
DB_CONNECTION_TIMEOUT_MS=10000

# LLM
LLM_PROVIDER
LLM_MODEL
LLM_API_KEY
LLM_MAX_CONTEXT_TURNS=12
LLM_PROMPT_CACHE_ENABLED=true

# STT
STT_PROVIDER=openai
STT_MODEL=gpt-transcribe            # 由阶段 2.5 benchmark 裁决
STT_CONTEXT_HINTS_ENABLED=false     # 见 §6.1
OPENAI_API_KEY

# Audio
AUDIO_TARGET_CONTAINER=webm         # STT 输入容器
AUDIO_REMUX_COPY_CODEC=true         # 禁止重编码
AUDIO_MAX_DURATION_SECONDS=120
AUDIO_MAX_SIZE_MB=20                # 低于 OpenAI 25MB 上限

# TTS
TTS_PROVIDER=minimax
TTS_MODEL_CONVERSATION=speech-2.8-turbo
TTS_MODEL_TEACHING=speech-2.8-hd
TTS_MAX_CHARACTERS=400
MINIMAX_API_KEY
MINIMAX_VOICE_ID

# Correction rhythm（见 §5.4）
SURFACE_AFTER_TURNS_CONVERSATION=4
SURFACE_AFTER_TURNS_COACH=1
SURFACE_MAX_ITEMS=3
SURFACE_HIGH_IMPORTANCE_THRESHOLD=2

# Session & scheduling
USER_TIMEZONE=Asia/Singapore
SESSION_IDLE_MINUTES=30
DAILY_REMINDER_LOCAL_TIME=20:30
NIGHTLY_BACKUP_LOCAL_TIME=03:00

# Budget & logging
DAILY_COST_SOFT_LIMIT_USD
MONTHLY_COST_SOFT_LIMIT_USD
LOG_LEVEL
```

所有配置在启动时由 Zod 校验；缺少必需配置时进程 fail fast，不以 `undefined` 进入运行态。

启动自检还应包含：FFmpeg 可执行且支持所需 codec、数据库可连接、各 provider 密钥格式合法。

---

# 18. 结论

本方案的核心不是将更多模型堆叠在一条消息上，而是建立一个可持续的学习闭环：**对话保持自然，纠错保持克制，学习事实保持结构化，长期记忆真正影响未来课程。**

V1.1 相对基线稿没有改变这个方向，只是修掉了三类会让方向落空的东西：

1. **会静默污染数据的**（STT 顺手改错、纠错在延迟期间丢失证据）；
2. **会静默中断服务的**（Neon 算力额度、备份窗口）；
3. **会让控制手段作用错位的**（成本结构误判、纠错节奏交给模型自觉）。

这三类的共同特征是不会在开发期报错，而会在运行数周后以数据可疑或服务中断的形式暴露，因此值得在动工前就写进设计。

最终 V1 基线可概括为：

> **Telegram Long Polling + TypeScript/grammY 模块化单体 + FFmpeg remux + OpenAI STT（benchmark 裁决）+ MiniMax Speech 2.8 Turbo/HD + Provider Adapter + Drizzle/Neon Postgres（按需唤醒）+ Railway Hobby 常驻计算 + 程序控制的纠错节奏。**

开发应从"发送一条日语语音并收到可追踪的日语语音回复"这一纵向闭环开始，再逐步加入 Tutor 行为、长期 Memory、Curriculum 与生产可靠性。只要 Learner Memory 能持续积累、Daily Plan 能真实复用过去表现、故障不会导致重复或数据丢失，V1 就已经具备区别于普通聊天机器人的核心价值。

---

# 参考资料与时效说明

本文中的平台能力与价格均为 **2026-08-12** 核实的设计基线，实施前应再次核对官方页面：

1. [Telegram Bot API：getUpdates、sendVoice 格式要求与 50MB 上限](https://core.telegram.org/bots/api) — 已核实 `sendVoice` 接受 .OGG/OPUS、.MP3、.M4A
2. [OpenAI 转写指南：支持格式与 25MB 上限](https://developers.openai.com/api/docs/guides/speech-to-text) — 已核实支持格式为 mp3/mp4/mpeg/mpga/m4a/wav/webm，**不含 ogg**
3. [OpenAI GPT Transcribe 模型页](https://developers.openai.com/api/docs/models/gpt-transcribe) — $0.0045/min，支持 context/keyword hints
4. [OpenAI API 价格](https://developers.openai.com/api/docs/pricing) — 各转写模型单价对照
5. [MiniMax Speech 2.8 模型概览](https://platform.minimax.io/docs/guides/models-intro)
6. [MiniMax T2A HTTP API：模型、日语增强与输出格式](https://platform.minimax.io/docs/api-reference/speech-t2a-http) — 输出 mp3/wav/flac/pcm
7. [MiniMax API 价格](https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise) — Turbo $60 / HD $100 per 1M characters
8. [Railway Pricing Plans](https://docs.railway.com/pricing/plans) — Hobby $5/月含 $5 额度；RAM $10/GB·月，vCPU $20/vCPU·月
9. [Neon Plans：Free 额度与 scale-to-zero](https://neon.com/docs/introduction/plans) — 100 CU-hours/project/月，0.5GB 存储，5 分钟强制休眠
10. [Neon Backup & Restore](https://neon.com/docs/guides/backup-restore) — Free 计划 PITR 窗口 6 小时 / 1GB
11. [Drizzle ORM — Neon 连接方式](https://orm.drizzle.team/docs/connect-neon) — `neon-http` 不支持交互式事务
12. [grammY](https://github.com/grammyjs/grammY) — 当前 1.45.1

价格仅用于预算设计，不构成长期报价。生产系统以 provider usage、实际账单和带版本的价目表为准。
