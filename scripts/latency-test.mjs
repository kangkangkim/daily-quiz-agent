// 延迟剖析：测 提交→首个文字 / 判定 / 总时长
const BASE = 'http://localhost:3456';
const t0 = performance.now();
const user = `测速${Math.floor(Math.random() * 100000)}`;

const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user, message: '【提交答案】C', history: [] }),
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
const marks = {};
outer: while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const parts = buf.split('\n\n');
  buf = parts.pop() || '';
  for (const part of parts) {
    const ev = part.split('\n').find((l) => l.startsWith('event: '))?.slice(7).trim();
    if (!ev) continue;
    if (ev === 'text' && !marks.firstText) marks.firstText = performance.now() - t0;
    if (ev === 'verdict' && !marks.verdict) marks.verdict = performance.now() - t0;
    if (ev === 'done') { marks.total = performance.now() - t0; break outer; }
  }
}
const fmt = (ms) => (ms ? `${(ms / 1000).toFixed(1)}s` : '–');
console.log(`首条文字: ${fmt(marks.firstText)}  判定: ${fmt(marks.verdict)}  总时长: ${fmt(marks.total)}`);
