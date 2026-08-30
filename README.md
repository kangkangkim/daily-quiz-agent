# 每日一题 · 康康小老师 🎈 📚

基于 **Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk`）的每日做题 Web 应用：
每天打开 → 做一道题 → 康康小老师 Agent **判对判错** → 围绕题目**答疑讲解**。

## 功能

- **每日一题**：按日期（默认 Asia/Shanghai）出题，题目含题干/选项/标准答案/要点 keyPoints/解析，存在 `questions/<日期>.json`
- **Agent 判题**：康康小老师 Agent 通过工具读取标准答案后判定；**选择题由服务端确定性校正**（字母精确匹配），不依赖 LLM 心情
- **答疑康康小老师**：提交答案前只给提示不剧透；答错引导重试（错 2 次或主动放弃才公布答案）；答对后给完整讲解
- **答题统计**：今日作答次数、累计答对天数、连续答对天数
- **实时排行榜** 🏆：全员排名（累计答对 > 连续答对 > 今日是否答对 > 参与天数）；**任何人作答，所有打开的页面 ≤0.5s 内自动刷新**（SSE 推送 `GET /api/leaderboard/stream`，断线自动降级轮询）；前三名领奖台 + 第 4 名起列表，名次变动行会闪烁提示，自己那行高亮
- **元气教室界面** 🎨：暖米底 + 珊瑚/琥珀/青绿活力配色，Hero 期号带实时"今日作答/答对"人数，答对时撒花 🎉
- **聊天 Markdown 渲染**：康康回复中的表格/列表/标题/加粗/行内代码安全渲染（先整体 HTML 转义再做结构转换，防 XSS）
- **往期回顾** 📚：`GET /api/history` + 手风琴面板，可回顾每期题干/选项（正确答案高亮）/答案/考察要点/解析；今日题不进历史，防剧透
- **出题管理页** `/admin.html`：可视化加题/改题，或用 CLI 脚本
- **SSE 流式输出**：康康小老师的回复边生成边显示
- 测试深链：`/#name=某某` 预设答题人；`/#history=1` 展开往期回顾；`/#open=1` 或 `/#open=2026-08-28` 自动展开最近一期/指定日期

## 内置课程线（8 天）

按 LLM 工程师的成长路径设计，题目有深度、干扰项"似是而非"：

| 日期 | 主题 | 题型 |
|---|---|---|
| 08-25 | 大模型基础 · 上下文窗口 | 单选 |
| 08-26 | 大模型基础 · 解码与采样 | 单选 |
| 08-27 | 大模型基础 · 推理系统 KV Cache | 多选 |
| 08-28 | Prompt Engineering · few-shot 示例设计 | 单选 |
| 08-29 | Prompt Engineering · 提示注入攻防 | 主观 |
| 08-30 | Context · 长上下文与检索 | 单选 |
| 08-31 | Harness · Agent 执行框架 | 多选 |
| 09-01 | Graph · 多步编排/状态图 | 单选 |

## 快速开始

```bash
npm install
npm start          # http://localhost:3456
```

管理页（出题）：http://localhost:3456/admin.html

### 鉴权

Agent SDK 会启动本机 Claude Code 运行时，沿用环境里的凭据：

- 本机已登录 `claude` CLI：开箱即用
- 走网关：设置 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 环境变量（Anthropic 兼容协议均可）

### 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3456` | 服务端口 |
| `QUIZ_TZ` | `Asia/Shanghai` | 「今天」的时区 |

## 加题

**方式一：管理页** `/admin.html`（推荐）

**方式二：CLI**

```bash
node scripts/add-question.js --date 2026-09-02 --subject "Graph · 多智能体" \
  --type single-choice --question "题干……" \
  --A "选项A" --B "选项B" --C "选项C" --D "选项D" --answer C \
  --keyPoints "要点1" --keyPoints "要点2" --explanation "完整解析"
```

**题型说明**：`single-choice`（单选）/ `multi-choice`（多选，答案如 `AB`）/ `free`（主观题，Agent 按要点语义判定）

## 目录结构

```
├── server.js            # Express 服务 + SSE 聊天接口
├── agent/teacher.js     # 康康小老师 Agent（系统提示词 + 判题/读题工具 + 确定性校正）
├── lib/questions.js     # 题目存取与校验
├── lib/attempts.js      # 答题记录与统计
├── questions/*.json     # 题库（一天一题）
├── public/              # 前端（答题页 + 管理页）
└── scripts/add-question.js
```

## 安全说明

- `/api/admin/*` 未做鉴权，仅适合本地/可信内网；公网部署请自行加反代鉴权或 IP 白名单
- 系统提示词层面做了防剧透约束，但 LLM 约束不是硬保证；标准答案从不出现在公开 API 返回里

## 自测验收清单（已跑通）

1. `GET /api/today` 返回题目且**不含** answer/keyPoints/explanation
2. 答对（提交 `C`）→ verdict correct=true，讲解完整
3. 答错（提交 `A`）→ verdict correct=false，先给提示不直接泄答案
4. 未提交时提问「答案是什么」→ 康康拒绝剧透
5. 选择题判定由服务端确定性校正（Agent 判错也会被纠正；小写/写选项全文/多选乱序都能正确匹配）
6. 主观题按 keyPoints 语义判定：覆盖要点判对、跑偏判错
7. 答题记录写入 `data/attempts.json`，统计接口正确
8. 管理接口加题/校验/公开读取正确，非法题目返回 400
9. 多轮答疑有记忆：session resume 正常，服务重启后回退为「历史折叠」仍保有上下文
10. 纯提问不会误记录判定
11. 往期回顾：`/api/history` 只含今天之前的题目，含答案/要点/解析与真实期号；今日题不出现
12. Markdown 渲染：表格/列表/标题/加粗/行内代码正常渲染，HTML 标签全部转义不执行

## 测试脚本

服务需先启动（`npm start`），然后：

```bash
node scripts/e2e-test.mjs        # 主流程：防剧透 / 判对判错 / 全文映射 / 统计
node scripts/e2e-multiturn.mjs   # 多轮记忆：resume + 历史折叠回退
node scripts/e2e-freetext.mjs    # 主观题语义判定 + 判题单元测试 + 管理接口（自起独立服务，不污染数据）
```
