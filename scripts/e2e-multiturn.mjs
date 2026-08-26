// E2E：多轮会话记忆（resume 路径 + 无 session 时的历史折叠 fallback 路径）
import fs from 'node:fs';

const BASE = 'http://localhost:3456';
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const q = JSON.parse(fs.readFileSync(`questions/${today}.json`, 'utf8'));
const correctAnswer = q.type === 'free' ? 'C' : q.answer; // 主观题任意文本即可
const answerWord = q.type === 'free' ? '要点' : correctAnswer;

async function chat(user, message, history = []) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, message, history }),
  });
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

const text = (events) => events.filter((e) => e.event === 'text').map((e) => e.data.t).join('');

function assert(cond, name, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const user = `记忆同学${Math.floor(Math.random() * 100000)}`;

// R1: 提交正确答案
{
  const ev = await chat(user, `【提交答案】${correctAnswer}`);
  const verdict = ev.find((e) => e.event === 'verdict')?.data;
  assert(verdict?.correct === true, `R1 提交 ${correctAnswer} 判对`, JSON.stringify(verdict));
}

// R2: resume 路径——追问刚才提交了什么（服务未重启，应能记住）
{
  const ev = await chat(user, '记忆检查：我刚才提交的答案是什么？直接告诉我内容。');
  const reply = text(ev);
  assert(reply.includes(answerWord), `R2 resume 会话记得刚才提交的是 ${answerWord}`, reply.slice(0, 200));
  assert(!ev.some((e) => e.event === 'verdict'), 'R2b 纯提问不触发误判定');
}

// R3: fallback 路径——新用户（无 session），历史由客户端折叠传入
{
  const user2 = `折叠同学${Math.floor(Math.random() * 100000)}`;
  const ev = await chat(user2, '记忆检查：我刚才提交的答案是什么？直接告诉我那个字母就行。', [
    { role: 'user', content: '【提交答案】B' },
    { role: 'assistant', content: '不对哦，B 不对，再想想提示……' },
  ]);
  const reply = text(ev);
  assert(/\bB\b/.test(reply), 'R3 无 session 时历史折叠生效（记得提交过 B）', reply.slice(0, 200));
}

console.log('\n==== 多轮记忆测试结束 ====');
