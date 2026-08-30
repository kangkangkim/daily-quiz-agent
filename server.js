// 每日一题 · 康康小老师 —— Web 服务
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayStr } from './lib/date.js';
import {
  getQuestion,
  saveQuestion,
  publicView,
  listQuestionDates,
} from './lib/questions.js';
import { getAttempts, userStats, leaderboard, recordAttempt, todaysAttemptsForUser } from './lib/attempts.js';
import { runTeacher, parseSubmission, judgeDeterministic } from './agent/teacher.js';
import { bus } from './lib/bus.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3456);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const NAME_RE = /^[\p{L}\p{N}_\-· ]{1,24}$/u;
function cleanName(raw) {
  const s = String(raw ?? '').trim();
  return NAME_RE.test(s) ? s : null;
}

// ---------- 实时榜单广播（SSE） ----------
const boardClients = new Set(); // 在线订阅者

function todaySnapshot() {
  const date = todayStr();
  const attempts = getAttempts(date);
  const users = new Map();
  for (const a of attempts) {
    if (!users.has(a.user)) users.set(a.user, false);
    if (a.correct) users.set(a.user, true);
  }
  return {
    participantsToday: users.size,
    correctToday: [...users.values()].filter(Boolean).length,
  };
}

function boardPayload() {
  return { ...leaderboard({ limit: 10 }), ...todaySnapshot() };
}

let broadcastTimer = null;
function scheduleBroadcast() {
  // 短时间去抖：一次作答（预判 + Agent 记录）只广播一次
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const payload = JSON.stringify(boardPayload());
    for (const res of boardClients) {
      try {
        res.write(`event: board\ndata: ${payload}\n\n`);
      } catch { /* 断开的连接由 close 事件清理 */ }
    }
  }, 400);
}
bus.on('attempt', scheduleBroadcast);

app.get('/api/leaderboard/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: board\ndata: ${JSON.stringify(boardPayload())}\n\n`);
  boardClients.add(res);
  const hb = setInterval(() => res.write(': hb\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(hb);
    boardClients.delete(res);
  });
});

// ---------- 题目 ----------
app.get('/api/today', (req, res) => {
  const date = todayStr();
  const q = getQuestion(date);
  if (!q) {
    return res.status(404).json({ error: '今天还没有题目', date });
  }
  // 期号 = 题库中 ≤ 今天的题目数
  const issueNo = listQuestionDates().filter((d) => d <= date).length;
  res.json({
    date,
    issueNo,
    question: publicView(q),
    totalAttemptsToday: getAttempts(date).length,
    ...todaySnapshot(),
  });
});

app.get('/api/question/:date', (req, res) => {
  const q = getQuestion(req.params.date);
  if (!q) return res.status(404).json({ error: '该日期没有题目' });
  res.json({ date: q.date, question: publicView(q) });
});

// ---------- 往期回顾（今天之前的题目带答案与解析；今日题不进历史，防剧透） ----------
app.get('/api/history', (_req, res) => {
  const today = todayStr();
  const items = listQuestionDates()
    .filter((d) => d < today)
    .sort() // 升序：下标+1 即真实期号
    .map((d, i) => {
      const q = getQuestion(d);
      if (!q) return null;
      return {
        issueNo: i + 1,
        date: q.date,
        subject: q.subject,
        type: q.type,
        question: q.question,
        options: q.options ?? null,
        answer: q.answer,
        answerText: q.answerText ?? '',
        keyPoints: q.keyPoints ?? [],
        explanation: q.explanation ?? '',
      };
    })
    .filter(Boolean)
    .reverse(); // 最新在前
  res.json({ items });
});

// ---------- 知识图谱（由题库动态生成：科目=中心节点，每道题=叶子节点） ----------
app.get('/api/graph', (_req, res) => {
  const today = todayStr();
  const dates = listQuestionDates().sort();
  const bySubject = new Map();
  dates.forEach((d) => {
    const q = getQuestion(d);
    if (!q) return;
    const full = q.subject ?? '未分类';
    const hubKey = (full.split('·')[0] ?? '').trim() || full; // 「·」前是科目（中心节点）
    if (!bySubject.has(hubKey)) bySubject.set(hubKey, []);
    bySubject.get(hubKey).push({
      date: d,
      issueNo: dates.indexOf(d) + 1,
      label: (full.split('·').pop() ?? '').trim() || full, // 「·」后是知识点（叶子节点）
      type: q.type,
      status: d < today ? 'past' : d === today ? 'today' : 'future',
    });
  });
  const subjects = [...bySubject.entries()]
    .map(([subject, items]) => ({ subject, label: (subject.split('·')[0] ?? '').trim() || subject, items }))
    .sort((a, b) => (a.items[0]?.date < b.items[0]?.date ? -1 : 1)); // 学习路径顺序
  res.json({ today, subjects });
});

// ---------- 统计 ----------
app.get('/api/stats', (req, res) => {
  const user = cleanName(req.query.user);
  if (!user) return res.status(400).json({ error: '缺少合法的 user 参数' });
  res.json(userStats(user));
});

// ---------- 排行榜 ----------
app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const board = leaderboard({ limit });
  const user = cleanName(req.query.user);
  const me = user ? board.all.find((r) => r.user === user) ?? null : null;
  delete board.all; // 全量名单仅服务端排序用，不外发
  res.json({ ...board, ...todaySnapshot(), me });
});

// ---------- 康康小老师聊天（SSE 流式） ----------
app.post('/api/chat', async (req, res) => {
  const user = cleanName(req.body?.user);
  const message = String(req.body?.message ?? '').trim();
  if (!user) return res.status(400).json({ error: '请先告诉我们你的名字' });
  if (!message || message.length > 2000) {
    return res.status(400).json({ error: '消息不能为空且不超过 2000 字' });
  }

  const date = todayStr();
  const q = getQuestion(date);
  if (!q) return res.status(404).json({ error: '今天还没有题目，无法开始答疑' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('meta', { date, user });

  // ---- 快路径：选择题提交 → 服务端确定性预判，verdict 立即下发，不等模型 ----
  const answerText = parseSubmission(message);
  let precomputed = null;
  if (answerText !== null) {
    const det = judgeDeterministic(q, answerText);
    if (det) {
      const attemptNo = getAttempts(date).filter((a) => a.user === user).length + 1;
      recordAttempt(date, {
        user,
        answer: answerText.slice(0, 500),
        correct: det.correct,
        comment: det.correct ? '标准答案匹配' : '',
      });
      precomputed = { correct: det.correct, attemptNo };
      send('verdict', {
        correct: det.correct,
        comment: det.correct ? '干脆利落！' : '',
        overridden: false,
        attemptNo,
        attemptsToday: todaysAttemptsForUser(user, date).length,
        totalToday: getAttempts(date).length,
      });
      bus.emit('attempt');
    }
  }

  try {
    await runTeacher({
      user,
      date,
      message,
      history: req.body?.history,
      precomputed,
      onText: (t) => send('text', { t }),
      onVerdict: (v) => {
        send('verdict', v);
        bus.emit('attempt');
      },
    });
    send('done', { ok: true });
  } catch (err) {
    console.error('[chat] agent error:', err?.message ?? err);
    send('error', { message: '康康小老师暂时开小差了，请稍后再试' });
  }
  res.end();
});

// ---------- 管理接口（本地/内网工具，未做鉴权；公网部署请自行加锁） ----------
app.get('/api/admin/questions', (req, res) => {
  res.json(
    listQuestionDates()
      .reverse()
      .map((date) => getQuestion(date))
      .filter(Boolean),
  );
});

app.get('/api/admin/question/:date', (req, res) => {
  const q = getQuestion(req.params.date);
  if (!q) return res.status(404).json({ error: '该日期没有题目' });
  res.json(q);
});

app.post('/api/admin/question', (req, res) => {
  try {
    const saved = saveQuestion(req.body);
    res.json({ ok: true, question: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, date: todayStr() }));

app.listen(PORT, () => {
  console.log(`每日一题 · 康康小老师 已启动: http://localhost:${PORT}`);
  console.log(`管理页（出题）: http://localhost:${PORT}/admin.html`);
});
