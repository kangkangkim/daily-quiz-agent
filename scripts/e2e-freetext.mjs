// E2E 补充测试：主观题（free）语义判定 + 确定性判题单元测试 + 管理接口
// 在独立端口 + 独立题目/数据目录上跑，不污染正式数据
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { judgeDeterministic } from '../agent/teacher.js';

const PORT = 3457;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TDIR = '/tmp/quiz-e2e-free';
fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(path.join(TDIR, 'questions'), { recursive: true });
fs.mkdirSync(path.join(TDIR, 'data'), { recursive: true });

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

// 主观题：简化的提示注入题
fs.writeFileSync(
  path.join(TDIR, 'questions', `${today}.json`),
  JSON.stringify({
    date: today,
    subject: '安全',
    type: 'free',
    question: '请举出一种提示注入攻击方式，并给出一条对应的防御措施。',
    answer: '攻击：用户输入或外部内容中藏指令覆盖系统指令（直接/间接注入）。防御：不可信内容隔离到数据区 / 工具最小权限 / 参数校验白名单等任一条。',
    answerText: '',
    keyPoints: [
      '提到把指令藏在输入或外部内容里（直接或间接注入）',
      '给出一条合理防御：数据区隔离、最小权限、白名单校验、人工确认等',
    ],
    explanation: '提示注入=数据与指令混通道；防御要分层。',
  }, null, 2),
);

function assert(cond, name, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

async function chat(user, message) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, message, history: [] }),
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

// ---- 单元：judgeDeterministic ----
{
  const q = {
    type: 'single-choice', answer: 'C',
    options: { A: '甲', B: '乙', C: '丙', D: '丁' },
  };
  assert(judgeDeterministic(q, 'c')?.correct === true, 'U1 小写 c 判对');
  assert(judgeDeterministic(q, '是 丙 ！')?.correct === true, 'U2 写选项内容判对');
  assert(judgeDeterministic(q, 'A 或 B')?.correct === false, 'U3 多字母判错');
  assert(judgeDeterministic(q, '不知道') === null, 'U4 无法确定 → 交给 LLM');
  const mq = { type: 'multi-choice', answer: 'AC', options: { A: '甲', B: '乙', C: '丙' } };
  assert(judgeDeterministic(mq, 'C、A')?.correct === true, 'U5 多选乱序判对');
  assert(judgeDeterministic(mq, 'AB')?.correct === false, 'U6 多选漏选判错');
  assert(judgeDeterministic({ type: 'free' }, '任何内容') === null, 'U7 free 题 → LLM 语义判定');
}

// ---- 起独立服务 ----
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    QUIZ_QUESTIONS_DIR: path.join(TDIR, 'questions'),
    QUIZ_DATA_DIR: path.join(TDIR, 'data'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

// 等服务就绪
let up = false;
for (let i = 0; i < 20; i++) {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) { up = true; break; }
  } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 300));
}
if (!up) {
  console.error('❌ 测试服务未启动');
  child.kill();
  process.exit(1);
}

try {
  const user = '主观题同学';

  // 覆盖要点的回答 → 判对
  {
    const ev = await chat(user, '【提交答案】攻击者可以在用户输入或网页内容里藏指令，比如"忽略之前的指令"，模型读到就会执行，这就是提示注入（间接注入藏在外部内容里）。防御：把不可信内容放进单独的数据区，声明它不是指令，同时对工具参数做白名单校验。');
    const verdict = ev.find((e) => e.event === 'verdict')?.data;
    assert(verdict?.correct === true, 'F1 主观题答出攻击+防御 → 判对', JSON.stringify(verdict));
  }

  // 完全跑偏的回答 → 判错
  {
    const ev = await chat(user, '【提交答案】提示注入就是 SQL 注入的一种，防御办法是给数据库加密码。');
    const verdict = ev.find((e) => e.event === 'verdict')?.data;
    assert(verdict?.correct === false, 'F2 主观题跑偏 → 判错', JSON.stringify(verdict));
    assert(verdict?.attemptNo === 2, 'F2b 第 2 次作答', JSON.stringify(verdict));
  }

  // 管理接口：加一道未来日期的题
  {
    const res = await fetch(`${BASE}/api/admin/question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: '2026-12-31', subject: '测试', type: 'single-choice',
        question: '测试题？', options: { A: '1', B: '2' }, answer: 'a',
        keyPoints: ['k'], explanation: 'e',
      }),
    });
    const data = await res.json();
    assert(res.ok && data.question?.answer === 'A', 'A1 管理接口加题（answer 归一化为大写）', JSON.stringify(data));

    const bad = await fetch(`${BASE}/api/admin/question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-31', type: 'single-choice', question: 'x', options: { A: '1' }, answer: 'Z' }),
    });
    assert(bad.status === 400, 'A2 非法题目被拒绝（400）');

    const get = await fetch(`${BASE}/api/question/2026-12-31`).then((r) => r.json());
    assert(get?.question?.question === '测试题？' && !('answer' in get.question), 'A3 公开接口可读且不含答案', JSON.stringify(get));
  }

  // 前端静态资源
  {
    const html = await fetch(BASE).then((r) => r.text());
    assert(html.includes('每日一题'), 'S1 首页可访问');
    const admin = await fetch(`${BASE}/admin.html`).then((r) => r.text());
    assert(admin.includes('出题管理'), 'S2 管理页可访问');
    const js = await fetch(`${BASE}/app.js`).then((r) => r.status);
    assert(js === 200, 'S3 app.js 可访问');
  }
} finally {
  child.kill();
}

console.log('\n==== 补充测试结束 ====');
