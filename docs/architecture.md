# MasaGo

## 日语学习系统 · 产品与技术架构设计方案

**版本：** V2.0（重定位版）
**日期：** 2026-08-14
**前身：** jp-coach V1.1（2026-08-12，陪练优先）
**适用范围：** 个人自用、长期运行的日语学习系统

---

## 修订说明：V1.1 → V2.0

V1.1 是「陪练优先」的方案：核心是语音对话，课程为辅。V2.0 按用户重新给定的优先级做了**产品重心翻转**，不是调参数而是换主体。

| # | 变更 | 原因 |
|---|---|---|
| C1 | **课程体系成为产品主体**，对话降为辅助 | 用户第一优先级是"有优秀清晰的课程体系，从 0 开始每日学习" |
| C2 | **学习者画像从中级改为真·零基础** | V1.1 假设"阅读 N3、口语 N4，认识但说不出来"；实际是五十音都不熟 |
| C3 | **课程骨架采用 JLPT 级别体系** | 五十音 → N5 → N4 → N3，开源词表与语法表现成，进度可量化 |
| C4 | **STT 退出 V1**，语音输入与发音评分移至 V2 | 用户明确降级：不用语音对话、不用 AI 判定发音 |
| C5 | **TTS 从配角升为核心**，并新增假名音库 | TTS 成为发音教学的唯一手段 |
| C6 | **LLM 改为 MiniMax M3**，结构化输出走强制工具调用 | 成本降至十分之一；MiniMax 不支持 `response_format` |
| C7 | **新增 MCP 第二界面**（ChatGPT 辅助对话练习） | 优先级低，但共享同一 Neon 数据 |
| C8 | **Review 调度改用 FSRS** | 替代 V1.1 的固定 1/3/7/14/30 间隔 |
| C9 | 项目更名 jp-coach → **MasaGo** | — |

**V1.1 中仍然成立、本版保留的部分：** 三层 Memory、Learning Events 可重算模型、Correction Scheduler（R6）、幂等策略、Neon 算力约束（R1）、可恢复状态机、观测与成本追踪、部署拓扑。这些不因产品重心变化而失效。

**一个重要的意外收益（见 §5.3）：** 改为文字输入后，V1.1 中最难的风险——STT 把学习者的语法错误"顺手改对"，导致 Error Bank 静默失真——**完全消失**。用户输入的原文就是 raw evidence，不存在转写失真。

---

# 1. 产品定位

## 1.1 一句话

MasaGo 是一个**课程驱动**的日语学习系统：它替学习者规划每天学什么、教会他、安排复习、并在真实表达中纠错。它不是一个"能聊日语的机器人"。

## 1.2 学习者画像

**真·零基础。** 五十音不熟，无词汇无语法。母语中文，这在汉字上是优势、在音读训读与助词上是劣势。

这决定了几件 V1.1 里不存在的事：

- 课程必须**从假名认读与发音开始**，而不是从对话开始
- 学习者**前期无法打日文**，输入方式需要设计（§4.3）
- 振假名是刚需，而 Telegram 不支持 ruby 标注（§4.2）
- "先表达后纠错"在零基础阶段不适用——没有可表达的内容之前，先教后练

## 1.3 核心目标

- 每天 15–30 分钟，由系统安排、无需自行备课
- 从五十音到 N3 有**清晰可见的进度轴**，而不是零散知识点
- 每个新知识都被安排进复习，且复习时机由算法而非固定表决定
- 学习事实结构化沉淀，长期记忆真正影响后续课程

## 1.4 V1 边界

- 单用户（一个白名单 Telegram ID）
- 无注册、支付、后台
- **不做语音输入、不做发音评分**（V2）
- 不做 Web Dashboard（V3 Mini App）

## 1.5 产品原则

- **课程有主线**：每天学什么由 Roadmap 决定，不是围绕偶然错误打转
- **LLM 不是数据库**：模型负责讲解、出题、评价表达；程序负责课程状态、复习调度、掌握度计算
- **节奏不交给模型**：何时纠错、何时复习、何时进阶，全部由程序按确定性规则决定
- **数据优先于生成**：词汇、语法、假名这类有权威来源的内容用开源数据，不让 LLM 现编
- **可替换供应商**：LLM、TTS 均通过 Adapter 接入

---

# 2. 课程体系（本方案的主体）

## 2.1 四个阶段

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| **S0 五十音** | 清音 → 浊音/半浊音 → 拗音 → 促音/长音 | 平假名片假名认读准确率稳定 ≥95%，能听音选字 |
| **S1 N5** | ~800 词、基础句型、助词入门 | N5 词汇掌握度达标 + 能就日常话题写出正确短句 |
| **S2 N4** | ~1500 词、动词变形体系、复合句 | N4 词汇达标 + 能表达意图与理由 |
| **S3 N3** | ~3700 词、敬语、自然表达 | — |

**阶段不是硬门槛。** 进入 S1 后 S0 的假名仍在复习队列里；掌握度由事件计算，不因"进入下一阶段"而清零。

## 2.2 S0 五十音的特殊设计

零基础阶段与后续完全不同，单独说明。

**三种能力分开训练与计量：**

| 能力 | 形式 | 数据 |
|---|---|---|
| 认读（見て読む） | 显示 か → 选择/输入读音 | 假名表 |
| 听辨（聞いて選ぶ） | 播放音频 → 选择对应假名 | **假名音库**（§5.2） |
| 书写形（形の識別） | 形近字区分：シ/ツ、ソ/ン、ね/わ/れ | 易混对照表 |

**形近假名必须专门处理。** シ/ツ、ソ/ン、ね/わ/れ、る/ろ 这些是零基础最大的卡点，不能只靠随机出题碰上。

**这一阶段不需要 LLM。** 出题、判分、调度全部是程序逻辑 + 静态数据 + 预合成音频。LLM 只在学习者问"为什么"时才介入解释。这让 S0 阶段的运行成本接近于零。

## 2.3 每日课程结构

固定骨架、动态内容：

| 模块 | 占比 | 目的 | 数据来源 |
|---|---:|---|---|
| 复习 | 30% | 对抗遗忘 | FSRS 到期队列 |
| 新知识 | 25% | 推进主线 | Roadmap 当前位置 |
| 应用练习 | 35% | 转为能力 | 新旧知识组合出题 |
| 小结 | 10% | 形成闭环 | 本日错误与掌握度变化 |

**复习占比高于 V1.1**，因为零基础阶段新知识密度大、遗忘快。

**每日约束：**
- S0：新假名 ≤5 个/天
- S1+：新词 ≤8 个、新语法点 ≤1 个/天
- 高价值纠错 ≤3 项
- 至少一次无提示输出练习

Daily Plan 在当天第一次学习时惰性生成（同时也是 §9.1 算力策略的要求）。

## 2.4 Roadmap 与内容池

**Roadmap** 保证主线：S0 假名顺序 → N5 → N4 → N3，按 JLPT 词表与语法表推进。

**四个内容池**（沿用 V1.1 §3.2 的思路）：
- **复习队列**：FSRS 到期项，最高优先级
- **Roadmap 新知识**：主线推进
- **薄弱点**：错误频次高的知识项
- **兴趣素材**：把个人兴趣嵌入例句与练习

## 2.5 优先级公式

```
Priority = 0.35 × 遗忘风险（FSRS 给出）
         + 0.25 × 错误频次
         + 0.25 × Roadmap 相关度
         + 0.15 × 实用度
         - 重复惩罚
```

相比 V1.1，遗忘风险与 Roadmap 权重提高，因为课程主线现在是产品核心。

## 2.6 起点评估

零基础不需要 V1.1 那种 10 分钟对话评估。改为**5 分钟假名快测**：随机抽 20 个假名认读，确定 S0 起点。若全对则跳过 S0 直接进 S1 快测。

---

# 3. 复习与掌握度

## 3.1 FSRS 替代固定间隔

V1.1 用 1/3/7/14/30 固定间隔，那是"先用透明规则、积累数据后再调"的占位方案。V2 直接采用 **FSRS**（Free Spaced Repetition Scheduler）：

- 开源、经大规模验证（Anki 已采用）
- `ts-fsrs` 提供 TypeScript 实现，要求 Node ≥20
- 按每个知识项的历史评分预测遗忘曲线，给出下次复习时间

**仍然遵守 V1.1 的原则**：调度是程序计算的结果，不允许 LLM 直接写一个分数。FSRS 只是把"程序计算"从朴素规则升级为经过验证的算法。

## 3.2 评分映射

FSRS 需要每次复习的评分（Again / Hard / Good / Easy）。映射规则：

| 学习事件 | FSRS 评分 |
|---|---|
| 无提示答对，响应快 | Easy |
| 无提示答对 | Good |
| 提示后答对 | Hard |
| 答错 / 召回失败 | Again |
| 自然表达中主动正确使用 | Easy |

**映射由程序完成**，模型只负责判定"这次表达是否正确"，不负责给间隔。

**"响应快"按输入方式分档**。同样 5 秒，点一个选项和用手机打日文含义相反；
用一个阈值去量，会把打字慢误读成没想起来，进而污染难度估计。
当前阈值：选择题 3s / 罗马字 6s / 日文 10s。取不到响应时间时降到 Good——
Easy 会大幅拉长间隔，用"没测到"当理由去拉长，是往忘记的方向下注。

**首次出现不给 Easy**（对上表的明确例外）。FSRS 对新卡片一旦收到 Easy，
会跳过学习步骤直接排到 8 天后。但初见的假名在四选一里蒙对的概率是 25%，
拿教完 30 秒后的这一次当依据就消掉 8 天，对零基础学习者赌注太大。
降到 Good 则是 10 分钟 → 2 天，即使漏判，损失也小。第二次起照上表执行:
偶然的正确不会连续发生，样本一多自然会被拉平。

## 3.3 Learning Events

沿用 V1.1 的事件类型，掌握度由事件流重算，允许将来更换算法后回溯重算：

```
INTRODUCED   REVIEWED   USER_ERROR   USER_CORRECT
RETRY_SUCCEEDED   FAILED_RECALL   USED_WITH_HINT
USED_SPONTANEOUSLY   MASTERED
```

---

# 4. 交互与展示

## 4.1 主界面：Telegram（文字）

文字输入、文字输出，配合 TTS 语音示范。**不接收语音消息**（V1 范围）。

## 4.2 振假名的显示限制

**Telegram 不支持 ruby 标注**，这是零基础课程的实际约束。

V1 方案：括注形式 `漢字（かんじ）`，并按学习者掌握度动态决定是否标注——已掌握的汉字不再标，避免干扰。

真正的 ruby 排版留到 V3 的 Mini App（§11）。

## 4.3 输入方式（零基础的新问题）

**学习者前期不会打日文**，输入方式需要分级：

| 阶段 | 输入方式 |
|---|---|
| S0 早期 | 选择题（发送编号或点按钮） |
| S0 后期 | 罗马字输入，程序转假名后判定 |
| S1+ | 直接输入日文（此时学习者已能用 IME） |

罗马字↔假名转换用成熟库完成（候选见 §8），**不由 LLM 转换**——这是确定性映射，交给模型只会引入不确定性和成本。

## 4.4 命令

```
/today    今日课程          /review   立即复习到期项
/kana     五十音训练        /progress 学习进度
/explain  追问上一条        /cost     成本
/end      结束今日 session
```

对话练习相关命令（`/talk`、`/roleplay`）在 V1 保留但为辅助功能。

## 4.5 Session 生命周期

沿用 V1.1：首条消息开启，30 分钟无活动或 `/end` 关闭，关闭时生成小结。**超时惰性判定，不做定时扫描**（§9.1）。

---

# 5. 语音：TTS 与假名音库

## 5.1 TTS 的新角色

STT 退出后，TTS 成为**发音教学的唯一手段**，重要性上升：

- 每个新词、新句给出标准发音
- 假名训练的听辨题
- 学习者可随时对任意日文请求发音

**MiniMax `speech-2.8-hd` 用于教学示范**（发音准确度优先），`speech-2.8-turbo` 用于长文本朗读。

## 5.2 假名音库（预合成）

**这是唯一适合"逐音预合成"的场景。**

一般情况下拼接假名合成句子是错的——日语是音高重音语言（箸 HL / 橋 LH / 端 LH平），且有母音无声化（です→"des"）、ん 的同化、長音、促音等连音现象，拼接会系统性教错韵律。

**但孤立假名教学不存在这些问题**：单个假名本来就没有上下文，没有音高曲线可言。

- 约 100 个音（清音 46 + 浊音 20 + 半浊音 5 + 拗音 33）
- 用 `speech-2.8-hd` 一次性合成，永久复用
- 随代码分发或存对象存储
- **S0 阶段的 TTS 成本降为零**

## 5.3 内容级 TTS 缓存

按 `hash(text + voice_id + model)` 缓存完整语句音频。适用场景在 V2 里比 V1.1 多得多：

- 复习队列按设计重复调度**同一批**知识项，同一例句几个月内会播放多次
- 课程例句、语法说明属固定内容
- 假名训练题目高度重复

命中即零成本且**音质无损**（存的是完整 MiniMax 输出，非拼接）。

**代价**：Railway 无状态（§10），持久缓存需接对象存储。V1 先用本地缓存 + 假名音库随代码分发；对象存储在 TTS 用量上升后再引入。

## 5.4 不做的事

- **不做发音评分**。STT 正确识别一个词只说明系统猜到了内容，不能证明音高、音素、mora timing 正确。V1 不输出任何形如"发音 8.7/10"的结论。
- **不接收语音输入**。

---

# 6. LLM：MiniMax M3

## 6.1 选型

| | 输入 /M | 输出 /M |
|---|---:|---:|
| MiniMax-M3 | $0.30 | $1.20 |
| （对照）claude-sonnet-5 | $3.00 | $15.00 |

十分之一成本。通过 **Anthropic 兼容端点** 接入：

```
ANTHROPIC_BASE_URL = https://api.minimax.io/anthropic
模型 = MiniMax-M3
```

这意味着现有 `@anthropic-ai/sdk` 代码基本不动，只换 base URL 与 token。

## 6.2 结构化输出：强制工具调用

**MiniMax 不支持 `response_format` / `output_config.format`**——其官方仓库 issue 明确记录该参数被**静默忽略**，且官方文档称该特性仅 MiniMax-Text-01 支持。退回 prompt 约束 JSON 会产出结构性畸形的输出。

**解法**：MiniMax Anthropic 兼容端点**完全支持 `tools` 与 `tool_choice`**（可强制指定工具）。定义一个 schema 即为期望输出结构的工具，强制调用，从 `tool_use.input` 取结构化结果。工具的 `input_schema` 会真正约束生成。

Zod schema 复用，只是挂载点从 `output_config.format` 改为 tool 的 `input_schema`。

## 6.3 参数差异

MiniMax 兼容端点的支持情况与 Anthropic 原生**不同**，实现时需注意：

| 参数 | MiniMax | Anthropic 原生 |
|---|---|---|
| `temperature` / `top_p` | 支持 | Sonnet 5 上非默认值 **400** |
| `tools` / `tool_choice` | 完全支持 | 支持 |
| `output_config.format` | **不支持** | 支持 |
| `top_k` / `stop_sequences` | **静默忽略** | 支持 |

**两边都合法的写法是不传采样参数**——现有实现正是如此，无需改动。

## 6.4 单次主调用

常规 turn 只做一次 LLM 调用。输入含课程上下文、学习者画像、当前知识项、最近对话；输出经 Zod 校验的结构化数据。

课程调度、复习安排、掌握度计算**不经过 LLM**。

## 6.5 Prompt Caching

MiniMax 支持自动 prompt caching。教学 Policy 与学习者画像作为稳定前缀放最前，动态内容置后。**system 前缀必须逐字节稳定**——插入时间戳或每次变化的值会使整个缓存失效，且这种失效是静默的。

---

# 7. 纠错机制

## 7.1 文字输入带来的简化

V1.1 最大的风险之一是「STT 把学习者错误顺手改对，Error Bank 静默失真」——为此设计了 Error Preservation Rate 基准、raw/normalized 分离、context hints 默认关闭等一整套防护。

**改为文字输入后这个风险完全消失**：用户打出来的原文就是 raw evidence。

`raw` 与 `normalized` 的分离仍然保留（normalized 用于辅助模型理解），但 raw 不再有失真来源。

## 7.2 Correction Scheduler（沿用 V1.1 R6）

模型每轮识别问题并**全部落库**，何时呈现由程序按确定性规则决定：

- 轮数达阈值（Conversation 4 / Coach 1）
- 高优先级问题积累达阈值
- 用户显式请求
- session 结束

**HOLD 时程序强制清空 correctionCard**，即使模型返回了也不呈现——识别与呈现结构性分离。

## 7.3 零基础阶段的调整

S0 与 S1 早期，"先表达后纠错"不适用——学习者还没有可自由表达的内容。这些阶段以**即时判分**为主（选择题、填空、认读），纠错即时给出。

延迟纠错从学习者能写出自由句子时开始生效，即 S1 中后期。

---

# 8. 开源数据与库整合

**原则**：有权威来源的内容用开源数据，不让 LLM 现编。词汇释义、JLPT 分级、假名读音这类事实数据，LLM 生成会有幻觉且不可复现。

| 用途 | 候选 | 说明 |
|---|---|---|
| 复习调度 | **ts-fsrs** | FSRS 算法的 TypeScript 实现，Node ≥20 |
| JLPT 词表 | **open-anki-jlpt-decks** | N5–N1 词汇 |
| 词典 + 分级 + 振假名 + 音高 | **JMdict / JMDict Extended** | 注意 JMdict 为 CC BY-SA，个人自用可，商用需查条款 |
| 振假名 / 罗马字转换 | **kuroshiro + kuroshiro-analyzer-kuromoji** | 纯 JS，无原生依赖（对 Railway 部署重要） |
| 形态素解析 | kuromoji | 用于分词、提取词汇、程序化判定助词与变形错误 |
| 资源索引 | awesome-japanese-nlp-resources | 查找具体工具的入口 |

**形态素解析值得单独说**：助词误用、动词变形错误这类有明确规则的错误，程序判定比 LLM 更可靠也更便宜。目前 Error Bank 完全依赖 LLM 识别；加一层程序化校验能提高数据可信度，也贴合 §1.5「LLM 不是数据库」。

**所有整合项在引入前需核实许可证与数据新鲜度。**

---

# 9. 数据与基础设施

## 9.1 Neon 算力约束（沿用 V1.1 R1，仍然有效）

Neon Free 为 **100 CU-hours/project/月**，scale-to-zero 在闲置 5 分钟后强制生效且不可关闭。若应用常驻并持有长连接，730h × 0.25 CU = 182.5 CU-h，约每月第 17 天 compute 被 suspend。

**四条设计约束，缺一不可：**
1. 小连接池（`max=2`）+ 短 idle timeout
2. Scheduler 用进程内定时器，**不做固定频率 DB 轮询**
3. Session 超时惰性判定，不做定时扫描
4. **health check 绝不查数据库**——平台探针会让 Neon 全天候不休眠

**实测（2026-08-12，旧 us-west-2 项目）**：最后查询到 compute 进入 idle 耗时 8 分 32 秒。据此典型一天约 45 分钟活跃 → 约 5.6 CU-hours/月，对 100 的额度有 18 倍余量。

## 9.2 核心表

沿用 V1.1 §7.2，按新定位调整：

| 表 | 变更 |
|---|---|
| `learner_profiles` | levels 改为记录当前阶段（S0/S1/S2/S3）与各维度进度 |
| `knowledge_items` | type 增加 `KANA`；承载假名、词汇、语法、表达、错误模式 |
| `review_queue` | 增加 FSRS 状态字段（stability、difficulty、last_review） |
| `daily_plans` / `daily_plan_items` | 不变 |
| `learning_events` | 不变 |
| `detected_issues` | 不变（R6） |
| `sessions` / `turns` | turns 的音频相关字段在 V1 不使用但保留 |
| `telegram_updates` / `usage_records` / `outbox_jobs` | 不变 |

## 9.3 幂等与可恢复

沿用 V1.1：`update_id` 唯一、`telegram_message_id` 唯一、Learning Event 确定性 dedupe key、可恢复 turn 状态机（文字 turn 状态链更短，无 AUDIO_* 状态）。

---

# 10. 部署

```
GitHub main → CI（lint/typecheck/test/build/migration check）
           → Railway Hobby（always-on 单实例）
           → Neon Postgres（按需唤醒）

外部依赖：Telegram · MiniMax（LLM + TTS）
持久状态：仅 Neon
临时文件：仅 Railway /tmp
```

Railway Hobby $5/月含 $5 额度，常驻进程实际约 $5–10/月。

**区域必须与 Neon 同区。** Neon 项目 `snowy-mouse-52341978`（MasaGo）位于 `ap-southeast-1`，**Railway 必须部署到 Southeast Asia 区**。真正影响性能的是 Railway ↔ Neon 之间的往返，不是用户 ↔ Neon；两者跨洋会把每轮的多次数据库查询放大成秒级开销。

实测参考（2026-08-14，本机 Mac ↔ Neon）：同区后集成测试从 16.4s 降至 2.9s、20.1s 降至 4.8s，快 4–6 倍。这测的是开发链路，但同样的往返差异会出现在 Railway ↔ Neon 上。

**Neon autoscaling 上限需压到 0.25 CU。** 新项目默认 `0.25–2 CU`，而 §9.1 的 18 倍余量是按 0.25 CU 计算的；上限 2 CU 意味着忙时可能烧 8 倍算力，余量缩至约 2.25 倍。单用户负载通常跑不满，但一次跑飞的查询就可能顶上去。

**FFmpeg 在 V1 不再是必需依赖**（STT 退出后无需 remux），但保留在构建配置中以备 V2。
由 `VOICE_INPUT_ENABLED` 控制：默认 false，只有开启语音输入时启动才要求 ffmpeg。

## 10.1 部署实况（2026-08-14 完成）

| 项 | 值 |
|---|---|
| Railway 项目 | `masago` / `64cb3bf1-3ef7-461e-b2e6-6b460fbe7966` |
| 服务 | `masago` / `b3831a18-df05-4bd9-bff1-6c9eaf3e730e` |
| 区域 | `sin`（新加坡，与 Neon `ap-southeast-1` 同区）|
| 健康检查 | `/health`，端口由 Railway 注入（实测 8080）|
| 构建 | Railpack，`pnpm build` → `pnpm start`（`dist/src/app.js`）|

**区域已实测确认，不是"设了就算"**：Railway API 里 `region` 字段读回来永远是
null（值存在不可查询的 `multiRegionConfig` 中），所以改为在启动时测量
`select 1` 的往返时间——温机后取中位数，**部署侧 4ms，本机（同在 ap-southeast-1）
56ms**。同区才可能是个位数。`railway service list` 亦显示 `region: sin`。

> 一发目的往返包含 TLS 握手与建连（实测 76ms），拿它判断地域会得出相反结论。

**目前是 `railway up` 直传，不是 GitHub 自动部署。** Railway 的 GitHub App
尚未获得 `agentjoey/masago` 的访问权（部署时报 `Repository not found or is not
accessible`），授权属于账号级操作。授权后即可恢复 `GitHub main → Railway` 的
自动部署链路。

**部署时的一处教训**：把 `.env` 按行 `KEY=VALUE` 切开灌进 Railway 是错的——
Node 的 `--env-file` 会剥掉行内注释，而朴素切分不会。四个变量因此带上了
`# <<< FILL ME ...` 尾巴，其中 `TELEGRAM_BOT_TOKEN` 与 `LLM_API_KEY`
都能通过 `z.string().min(1)`，只会在运行时以难以定位的方式失败；
只有数字型的 `ALLOWED_TELEGRAM_USER_ID` 当场报错才暴露了问题。
正确做法是用 Node 自己解析：`node --env-file=.env -e 'process.stdout.write(...)'`
取值，再经 stdin 灌入，与本地行为逐一比对（已核对 37/37 一致）。

---

# 11. 第二界面：MCP + ChatGPT

**优先级低，主链路不依赖它。**

ChatGPT Plus 支持 Developer Mode 接入自定义 MCP（远程 HTTPS 端点、SSE 或 Streamable HTTP）。MasaGo 暴露 MCP server 后，可在 ChatGPT 中查询进度、错题本、今日计划，并做自由对话练习。

**为什么不作为主链路**：MCP 的控制权在客户端——ChatGPT 决定何时调工具，服务端无法强制。这会摧毁 §7.2 的确定性纠错节奏（模型可能从不调、每轮调或随机调），也无法保证学习事件完整。

**合适的分工：**

| 场景 | 位置 |
|---|---|
| 课程、复习、纠错闭环 | MasaGo 主链路 |
| 查询进度 / 错题本 / 今日计划 | ChatGPT + MCP |
| 自由对话练习（不求纠错闭环） | ChatGPT |

长期记忆始终在 Neon，两个界面共享同一份数据。

---

# 12. 成本

按 V2 定位重估（每天 25 分钟、每月 30 天）：

| 项 | 月成本 | 说明 |
|---|---:|---|
| LLM（MiniMax M3） | $1–3 | 比 V1.1 的 $11–27 降一个数量级 |
| TTS（MiniMax） | $2–6 | 假名音库与内容缓存生效后进一步下降 |
| STT | **$0** | 退出 V1 |
| Railway | $5–10 | |
| Neon | $0 | 前提是 §9.1 生效 |
| **合计** | **$8–19** | V1.1 估算为 $21–47 |

**成本结构变了**：LLM 不再是大头，Railway 反而成为最大单项。这意味着继续压缩 LLM 成本的边际收益很低，优化重点应放在 TTS 缓存与基础设施。

每次调用产生 usage record，`/cost` 按日/周/月聚合，价目表带 `effective_from` 版本、历史成本按调用时价格计算。

---

# 13. 路线图

## V1 — 课程系统（本方案）
S0 五十音 → S1 N5；FSRS 复习；文字交互 + TTS 示范；假名音库；Correction Scheduler；MiniMax LLM；进度与成本可见。

## V1.5 — 课程深化
S2 N4；形态素解析驱动的程序化错误检测；周报与月度基准；MCP 第二界面。

## V2 — 语音回归
恢复语音输入（STT 适配器与 remux 管线已建好，直接启用）；发音评估（独立声学模块，禁止用 STT confidence 代替）；shadowing。

## V3 — Mini App
真正的 ruby 排版；进度看板；错题本浏览；复习日历。复用同一后端。

## V4 — 多用户
正式身份、租户隔离、Webhook + Queue、对象存储、配额与订阅。

---

# 14. 已建代码的处置

V1.1 阶段 1–3 已完成并通过验收的代码（256 条测试），按新定位分类：

| 模块 | 处置 |
|---|---|
| 工程骨架、配置校验、可观测性 | **保留**，不变 |
| DB schema、迁移、repositories | **保留**，按 §9.2 增量调整 |
| Telegram adapter、鉴权、幂等 | **保留**，不变 |
| Turn 状态机、Usage 计量 | **保留**，文字 turn 用更短的状态链 |
| Correction Scheduler（R6） | **保留**，§7.3 增加零基础阶段的调整 |
| 三种模式、命令路由 | **保留**，命令集按 §4.4 调整 |
| TTS（MiniMax 适配器） | **保留并升级**，增加假名音库与内容缓存 |
| Audio Normalizer / remux | **休眠**，V2 恢复语音时启用 |
| STT（OpenAI 适配器） | **休眠**，同上 |
| Voice Turn Pipeline | **休眠**，textTurn 继续使用 |
| Tutor（Anthropic 实现） | **改造**：换 MiniMax base URL + 强制工具调用 |

**休眠代码不删除**——已有测试覆盖，删掉再重写是净损失。

---

# 15. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| **零基础阶段枯燥导致中断** | 产品失效 | S0 用即时反馈与可见进度；控制单日新假名量；形近字专门训练 |
| MiniMax 强制工具调用不稳定 | 结构化输出失败 | **上线前实测**：强制调用是否被遵守、input 是否严格合 schema、连续多次是否稳定 |
| Neon 算力耗尽 | 服务月中停摆 | §9.1 四条约束；首月两次人工复核 |
| 开源数据许可证 | 合规风险 | 引入前逐项核实；JMdict 为 CC BY-SA |
| 课程主线与实际水平脱节 | 学习效率低 | 起点快测；掌握度事件驱动，进度自适应 |
| Telegram 无 ruby 支持 | 振假名体验受限 | V1 用括注；V3 Mini App 解决 |
| TTS 日语听感不自然 | 错误模仿 | 固定日本母语感音色；HD 用于教学示范 |

---

# 16. 配置

```
TELEGRAM_BOT_TOKEN
ALLOWED_TELEGRAM_USER_ID

DATABASE_URL
DATABASE_URL_DIRECT
DB_POOL_MAX=2
DB_POOL_IDLE_TIMEOUT_MS=15000

LLM_PROVIDER=minimax
LLM_BASE_URL=https://api.minimax.io/anthropic
LLM_MODEL=MiniMax-M3
LLM_API_KEY
LLM_PROMPT_CACHE_ENABLED=true

TTS_PROVIDER=minimax
TTS_MODEL_TEACHING=speech-2.8-hd
TTS_MODEL_READING=speech-2.8-turbo
TTS_MAX_CHARACTERS=400
MINIMAX_API_KEY
MINIMAX_VOICE_ID

KANA_AUDIO_DIR
TTS_CACHE_ENABLED=true

FSRS_REQUEST_RETENTION=0.9

SURFACE_AFTER_TURNS_CONVERSATION=4
SURFACE_AFTER_TURNS_COACH=1
SURFACE_MAX_ITEMS=3

USER_TIMEZONE=Asia/Singapore
SESSION_IDLE_MINUTES=30
DAILY_REMINDER_LOCAL_TIME=20:30

DAILY_COST_SOFT_LIMIT_USD
MONTHLY_COST_SOFT_LIMIT_USD
LOG_LEVEL
```

配置在启动时由 Zod 校验，缺少必需项 fail fast。

---

# 17. 结论

MasaGo 的核心不是"能聊日语"，而是**一条从五十音到 N3 的、每天都知道该学什么的路径**，配合真正会重来的复习和不会丢失的错误记录。

V1 基线：

> **Telegram 文字交互 + JLPT 课程主线 + FSRS 复习调度 + 假名音库与 MiniMax TTS + MiniMax M3（强制工具调用）+ 程序控制的纠错节奏 + Drizzle/Neon + Railway**

开发从「S0 五十音闭环」开始——那是最小的完整学习循环，且几乎不依赖 LLM，能最快验证课程引擎是否成立。

---

# 参考资料

平台能力与价格为 **2026-08-14** 核实的基线，实施前应再次核对：

1. [MiniMax Token Plan 集成指南](https://platform.minimax.io/docs/token-plan/other-tools) — OpenAI/Anthropic 兼容端点与密钥
2. [MiniMax Anthropic 兼容接口](https://platform.minimax.io/docs/api-reference/text-anthropic-api) — 参数支持表；`tools`/`tool_choice` 完全支持
3. [MiniMax M2.5 issue #4](https://github.com/MiniMax-AI/MiniMax-M2.5/issues/4) — `response_format` 不支持且静默忽略
4. [MiniMax Prompt Caching](https://platform.minimax.io/docs/api-reference/text-prompt-caching)
5. [MiniMax API 价格](https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise)
6. [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)
7. [open-anki-jlpt-decks](https://github.com/jamsinclair/open-anki-jlpt-decks)
8. [JMDict Extended](https://github.com/Bluskyo/JMDict_Extended)
9. [awesome-japanese-nlp-resources](https://github.com/taishi-i/awesome-japanese-nlp-resources)
10. [Neon Plans](https://neon.com/docs/introduction/plans) — 100 CU-hours/project/月
11. [Railway Pricing](https://docs.railway.com/pricing/plans)
12. [ChatGPT MCP Developer Mode](https://platform.openai.com/docs/mcp) — Plus 及以上支持自定义 MCP

价格仅用于预算设计。生产系统以 provider usage、实际账单和带版本的价目表为准。
