// 「康康小老师」Agent —— 基于 Claude Agent SDK（低延迟版）
// 设计：判题与讲解解耦。
//   - 选择题：服务端预判（确定性），verdict 秒回；Agent 只负责讲解，单轮、无工具
//   - 主观题：Agent 语义判定并调用 record_judgment 记录（唯一工具）
//   - 题目教参直接嵌入 prompt，省去"读题"一轮模型往返
import { createSdkMcpServer, tool, query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getQuestion } from '../lib/questions.js';
import { todaysAttemptsForUser, recordAttempt } from '../lib/attempts.js';

// 教学规则基座（教参和本轮情境按请求动态附加）
const BASE_PROMPT = `你是「每日一题 · 康康小老师」，名字叫康康，一位元气满满、亲切又严格的老师，每天带大家做一道练习题。

## 本轮情境（按此行动）
{{SCENARIO}}

## 判定规则（仅当需要你判定时）
- 选择题：以选项字母为准（忽略大小写、空格、标点）。用户写的是选项内容时，先映射成对应字母再比较。
- 主观题：按语义判断，核心要点（keyPoints）基本覆盖即算正确；表述不同但意思对就算对，不要吹毛求疵。
- 判定后必须调用一次 record_judgment 记录（用户原始答案、是否正确、一句评语）。系统会以标准答案为准校正，若被校正请以校正结果向用户反馈。
- 纯提问（如"答案是什么""为什么"）不是作答，绝不调用 record_judgment。

## 反馈规则
- 判对：祝贺用户，然后结合 keyPoints 和 explanation 给出完整讲解，可适当拓展一个相关小知识。
- 判错：不要立刻公布正确答案！先肯定思路中合理的部分，指出问题方向，给一个提示，鼓励再试一次。仅当用户今天已答错 2 次及以上，或明确表示"不想猜了/直接告诉我答案"时，才公布答案和完整解析。
- 答疑：围绕本题要点回答。用户今天还没提交过任何答案时，绝不直接泄露正确答案、选项正误或 keyPoints 原文，只给思考方向和提示。

## 风格
- 全程中文，口语化、亲切有活力，可以叫用户的名字，自称"康康"，偶尔用 1 个表情符号提气氛（不要连用）。
- 简洁：每次回复一般不超过 150 字，短段落或列表优先，直接开始说重点（不要"好的""让我看看"之类的铺垫）。
- 只依据教参里的信息讲，不编造题目里没有的内容。`;

// ---- 确定性判题（服务端兜底，选择题不依赖 LLM 判断） ----
// 标准答案侧归一化：出题人写 "AC"、"A、C" 都归一成 ['A','C']
function normalizeAnswerKey(answer) {
  return [...new Set(String(answer ?? '').toUpperCase().replace(/[^A-H]/g, ''))].sort();
}

function extractLetters(input, { adjacentSplit = false } = {}) {
  const t = String(input ?? '').toUpperCase().trim();
  const set = new Set();
  // 多选快路径：整条输入只由选项字母与常见分隔符组成（如 "AC" "A、C" "A 和 C"）
  // 才逐字符取字母——避免把选项文本里的英文单词（MQA/Value…）误拆成字母
  if (adjacentSplit && /^[A-H\s、，,./+·和与]+$/.test(t) && /[A-H]/.test(t)) {
    for (const ch of t) if (ch >= 'A' && ch <= 'H') set.add(ch);
    return [...set].sort();
  }
  // 兜底：只取「单独出现」的字母（避免匹配单词内部的字母，如 GPT 里的 G）
  for (const m of t.matchAll(/(?<![A-Z0-9])([A-H])(?![A-Z0-9])/g)) set.add(m[1]);
  return [...set].sort();
}

function normalizeText(s) {
  return String(s ?? '').replace(/\s+/g, '');
}

// 返回 { correct } 或 null（无法确定性判断，交给 LLM 语义判定）
export function judgeDeterministic(question, userAnswer) {
  if (!question || question.type === 'free') return null;
  const isMulti = question.type === 'multi-choice';
  let letters = extractLetters(userAnswer, { adjacentSplit: isMulti });
  if (letters.length === 0 && question.options) {
    // 用户可能写的是选项内容
    const norm = normalizeText(userAnswer);
    if (norm) {
      for (const [letter, text] of Object.entries(question.options)) {
        if (text && norm.includes(normalizeText(text))) letters.push(letter);
      }
      letters.sort();
    }
  }
  if (letters.length === 0) return null;
  const answer = normalizeAnswerKey(question.answer);
  if (!isMulti) {
    if (letters.length > 1) return { correct: false };
    return { correct: letters[0] === answer[0] };
  }
  return { correct: letters.join('') === answer.join('') };
}

// ---- 会话续接：每个 (用户, 日期) 维持一个 SDK session ----
const sessionIds = new Map(); // key: `${user}|${date}` -> session_id
const SESSION_CAP = 500;

function rememberSession(user, date, sessionId) {
  const key = `${user}|${date}`;
  if (sessionIds.size >= SESSION_CAP && !sessionIds.has(key)) {
    sessionIds.delete(sessionIds.keys().next().value);
  }
  sessionIds.set(key, sessionId);
}
function getSession(user, date) {
  return sessionIds.get(`${user}|${date}`);
}
function dropSession(user, date) {
  sessionIds.delete(`${user}|${date}`);
}

// 服务重启等导致 session 丢失时，把近期历史折叠成上下文前缀
function buildPromptWithFallbackHistory(message, history) {
  const turns = (Array.isArray(history) ? history : [])
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim(),
    )
    .slice(-8)
    .map((m) => `${m.role === 'user' ? '用户' : '康康'}：${m.content.slice(0, 800)}`)
    .join('\n');
  if (!turns) return message;
  return `［此前的对话记录，供你了解上下文，不要复述］\n${turns}\n\n［用户的新消息］\n${message}`;
}

export const SUBMIT_MARKER = '【提交答案】';

/**
 * 判定一条消息是否为「标记式提交」，返回答案文本（非提交返回 null）
 */
export function parseSubmission(message) {
  const msg = String(message ?? '');
  if (!msg.startsWith(SUBMIT_MARKER)) return null;
  return msg.slice(SUBMIT_MARKER.length).trim();
}

function makeJudgmentTool(question, user, date, onVerdict) {
  return tool(
    'record_judgment',
    '提交对用户答案的判定结果并记录。仅当用户本轮消息是作答时才可调用；用户只是提问时禁止调用。每次判定（无论对错）都必须调用一次，且每轮最多调用一次。',
    {
      user_answer: z.string().describe('用户提交的原始答案，原样保留'),
      correct: z.boolean().describe('是否答对'),
      comment: z.string().describe('给用户的一句简短评语（不超过 40 字）'),
    },
    async ({ user_answer, correct, comment }) => {
      // 服务端兜底：本轮不是【提交答案】且内容像提问（问号结尾/疑问词开头）→ 拒绝记录
      const ua = String(user_answer ?? '').trim();
      const looksLikeQuestion =
        /[?？]$/.test(ua) ||
        /^(这|那|为什么|怎么|如何|什么|哪个|请问|能不能|可以|帮我)/.test(ua);
      if (looksLikeQuestion) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: '这条消息是提问而不是作答，不能记录判定。请撤回判定意图，直接按答疑规则回答用户的问题（注意防剧透）。',
          }],
        };
      }

      const det = judgeDeterministic(question, user_answer);
      const finalCorrect = det ? det.correct : correct;
      const overridden = det ? det.correct !== correct : false;

      recordAttempt(date, {
        user,
        answer: String(user_answer).slice(0, 500),
        correct: finalCorrect,
        comment: String(comment ?? '').slice(0, 200),
      });
      const mine = todaysAttemptsForUser(user, date);

      onVerdict?.({
        correct: finalCorrect,
        comment: String(comment ?? ''),
        overridden,
        attemptNo: mine.length,
        attemptsToday: mine.length,
      });

      const lines = [
        `已记录：这是 ${user} 今天第 ${mine.length} 次作答，最终判定 = ${finalCorrect ? '答对 ✅' : '答错 ❌'}。`,
      ];
      if (overridden) {
        lines.push(
          `注意：你给出的判定与标准答案不一致，系统已按标准答案校正为「${finalCorrect ? '答对' : '答错'}」，请按校正后的结果向用户反馈。`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}

/**
 * 运行一次小老师会话（流式）。
 * @param {object} p
 * @param {string} p.user       用户名
 * @param {string} p.date       题目日期 YYYY-MM-DD
 * @param {string} p.message    用户本轮消息（原样，含【提交答案】标记若有）
 * @param {Array}  p.history    [{role:'user'|'assistant', content}]
 * @param {(t:string)=>void} p.onText     文本增量回调
 * @param {(v:object)=>void}  p.onVerdict 判定结果回调
 * @param {{correct:boolean, attemptNo:number}|null} p.precomputed
 *        服务端已预判并记录完成的选择题判定（此时 Agent 不再判定、无工具，只负责反馈）
 */
export async function runTeacher({ user, date, message, history, onText, onVerdict, precomputed }) {
  const question = getQuestion(date);
  if (!question) throw new Error(`${date} 没有题目，请先在管理页添加`);

  const attemptsBefore = todaysAttemptsForUser(user, date);
  const answerText = parseSubmission(message);

  // ---- 教参块（嵌入 prompt，免去一次取题工具往返） ----
  const syllabus =
    `## 本题教参（答案/要点已附上，按防剧透规则使用，无需再用工具取题）\n` +
    JSON.stringify({ ...question, userAttemptsToday: attemptsBefore });

  // ---- 本轮情境 ----
  let scenario;
  let tools = null; // null = 不挂任何工具
  if (precomputed) {
    // 情境 A：选择题已由服务端判定并记录，Agent 只负责讲解/引导
    scenario =
      `用户刚提交了答案「${answerText}」，系统已按标准答案自动判定并记录完毕：` +
      `${precomputed.correct ? '✅ 答对' : '❌ 答错'}（今天第 ${precomputed.attemptNo} 次作答，用户今日共作答 ${attemptsBefore.length} 次）。` +
      `你不需要再判定，也没有任何工具可调用。请直接按「反馈规则」回复：` +
      `${precomputed.correct ? '答对 → 祝贺 + 完整讲解 + 小拓展。' : '答错 → 先肯定合理的部分，给提示引导重试；若这是今天第 2 次及以上答错，可以公布答案和完整解析。'}`;
  } else if (answerText !== null) {
    // 情境 B：主观题（或字母无法解析的选择题）——Agent 判定并记录
    scenario =
      `用户刚提交了答案「${answerText}」。请你按「判定规则」判定：先给出判定与评语并调用 record_judgment 记录，` +
      `然后按「反馈规则」在同一轮回复里接着给出讲解或提示。`;
    tools = [makeJudgmentTool(question, user, date, onVerdict)];
  } else {
    // 情境 C：答疑/闲聊；若发现消息实际是作答，再走判定
    scenario =
      `用户在提问或讨论（今天已提交 ${attemptsBefore.length} 次，` +
      `${attemptsBefore.some((a) => a.correct) ? '已答对过，可逐步讲解' : attemptsBefore.length ? '已提交过但未答对，优先引导' : '尚未提交，严格防剧透'}）。` +
      `按「答疑规则」回答。若这条消息实际上是在陈述答案，请按「判定规则」先调用 record_judgment 再反馈。`;
    tools = [makeJudgmentTool(question, user, date, onVerdict)];
  }

  const systemPrompt = BASE_PROMPT.replace('{{SCENARIO}}', scenario) + '\n\n' + syllabus;

  let emitted = false;
  const guardedOnText = (t) => {
    emitted = true;
    onText?.(t);
  };

  const MODEL = process.env.QUIZ_MODEL ?? 'haiku'; // 快速模型足够讲解；可用 QUIZ_MODEL 覆盖

  async function runOnce(resumeId) {
    let sawStreamDeltas = false;
    let capturedSessionId = null;
    const q = query({
      prompt: resumeId
        ? String(message).slice(0, 4000)
        : buildPromptWithFallbackHistory(message, history),
      options: {
        systemPrompt,
        ...(tools ? { mcpServers: { teacher: createSdkMcpServer({ name: 'daily-quiz-teacher', version: '1.0.0', tools }) } } : {}),
        allowedTools: tools ? ['mcp__teacher__record_judgment'] : [],
        disallowedTools: [
          'Task', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
          'Glob', 'Grep', 'Read', 'TodoWrite', 'KillShell', 'BashOutput', 'ExitPlanMode',
        ],
        settingSources: [],
        maxTurns: 6,
        includePartialMessages: true,
        maxThinkingTokens: 0, // 讲解类任务不需要深度推理，砍掉思考延迟
        model: MODEL,
        ...(resumeId ? { resume: resumeId } : {}),
      },
    });

    for await (const msg of q) {
      if (msg.session_id) capturedSessionId = msg.session_id;
      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          sawStreamDeltas = true;
          guardedOnText(ev.delta.text);
        }
      } else if (msg.type === 'assistant') {
        const text = (msg.message?.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (text && !sawStreamDeltas) guardedOnText(text);
      }
    }
    return capturedSessionId;
  }

  const resumeId = getSession(user, date);
  try {
    const sid = await runOnce(resumeId);
    if (sid) rememberSession(user, date, sid);
  } catch (err) {
    // resume 失败（如 session 不存在）且尚未输出任何内容 → 去掉 resume 重试一次
    if (resumeId && !emitted) {
      dropSession(user, date);
      const sid = await runOnce(undefined);
      if (sid) rememberSession(user, date, sid);
    } else {
      throw err;
    }
  }
}
