// E2E 测试脚本：模拟用户完整流程（自动适配当天的题目，不硬编码答案）
import fs from 'node:fs';

const BASE = 'http://localhost:3456';

async function chat(user, message, history = []) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, message, history }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`HTTP ${res.status}: ${err.error || ''}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const part of parts) {
      const ev = part.split('\n').find((l) => l.startsWith('event: '))?.slice(7).trim();
      const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
      if (ev && dataLine) events.push({ event: ev, data: JSON.parse(dataLine.slice(6)) });
    }
  }
  return events;
}

const text = (events) =>
  events.filter((e) => e.event === 'text').map((e) => e.data.t).join('');

function assert(cond, name, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const q = JSON.parse(fs.readFileSync(`questions/${today}.json`, 'utf8'));
const isChoice = q.type !== 'free';
const correctAnswer = q.answer; // 选择题如 "ACD"；主观题为参考答案文本
const wrongLetter = isChoice
  ? Object.keys(q.options).find((L) => !q.answer.includes(L))
  : null;

console.log(`今日题目：${today} ${q.subject} (${q.type}，答案 ${isChoice ? correctAnswer : '<文本>'})`);
const user = `测试同学${Math.floor(Math.random() * 100000)}`;

// ---- T1: 未提交答案前，提问不能剧透 ----
{
  const ev = await chat(user, '这题答案是什么？直接告诉我选项');
  const reply = text(ev);
  const leak = isChoice
    ? new RegExp(`答案[是:：]\\s*${correctAnswer}|选[择]?\\s*${correctAnswer}\\b`).test(reply)
    : reply.includes(correctAnswer.slice(0, 20));
  assert(!leak, 'T1 未提交时提问，小老师不泄露答案', `回复: ${reply.slice(0, 200)}`);
}

if (isChoice) {
  // ---- T2: 答错，应判错且给提示而非直接公布 ----
  {
    const ev = await chat(user, `【提交答案】${wrongLetter}`);
    const verdict = ev.find((e) => e.event === 'verdict')?.data;
    const reply = text(ev);
    assert(verdict && verdict.correct === false, 'T2 答错 → 判定为错', JSON.stringify(verdict));
    assert(verdict?.attemptNo === 1, 'T2b 第 1 次作答');
    assert(!reply.includes(correctAnswer), 'T2c 答错后不直接公布答案组合', reply.slice(0, 200));
  }

  // ---- T3: 答对，应判对并完整讲解 ----
  {
    const ev = await chat(user, `【提交答案】${correctAnswer}`);
    const verdict = ev.find((e) => e.event === 'verdict')?.data;
    const reply = text(ev);
    assert(verdict && verdict.correct === true, 'T3 答对 → 判定为对', JSON.stringify(verdict));
    assert(verdict?.attemptNo === 2, 'T3b 第 2 次作答');
    assert(reply.length > 30, 'T3c 答对后有讲解', reply.slice(0, 200));
  }

  // ---- T4: 用户写选项内容（映射到答案字母），也应判对 ----
  {
    const user2 = `${user}b`;
    const fullText = [...correctAnswer].map((L) => q.options[L]).join('；');
    const ev = await chat(user2, `【提交答案】${fullText}`);
    const verdict = ev.find((e) => e.event === 'verdict')?.data;
    assert(verdict?.correct === true, 'T4 写选项全文也能映射判定为对', JSON.stringify(verdict));
  }
}

// ---- T5: 统计落盘 ----
{
  const res = await fetch(`${BASE}/api/stats?user=${encodeURIComponent(user)}`);
  const s = await res.json();
  const expected = isChoice ? 2 : 0;
  assert(
    s.days.find((d) => d.date === today)?.attempts === expected,
    `T5 统计：今天 ${expected} 次作答`,
    JSON.stringify(s.days),
  );
}

// ---- T6: 排行榜包含该用户 ----
{
  const res = await fetch(`${BASE}/api/leaderboard?user=${encodeURIComponent(user)}`);
  const b = await res.json();
  assert(b.me !== null, 'T6 排行榜能查到该用户', JSON.stringify(b.me));
}

console.log('\n==== 测试结束 ====');
