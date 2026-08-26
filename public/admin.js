// 出题管理页逻辑
const $ = (id) => document.getElementById(id);

function localToday() {
  const d = new Date();
  // 对齐服务端的 Asia/Shanghai 日期
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function fillForm(q) {
  $('f-date').value = q?.date ?? localToday();
  $('f-subject').value = q?.subject ?? '';
  $('f-type').value = q?.type ?? 'single-choice';
  $('f-question').value = q?.question ?? '';
  for (const L of ['A', 'B', 'C', 'D']) $(`f-${L}`).value = q?.options?.[L] ?? '';
  $('f-answer').value = q?.answer ?? '';
  $('f-answerText').value = q?.answerText ?? '';
  $('f-keyPoints').value = (q?.keyPoints ?? []).join('\n');
  $('f-explanation').value = q?.explanation ?? '';
  syncTypeUI();
}

function syncTypeUI() {
  const isChoice = $('f-type').value !== 'free';
  document.querySelector('.options-only').style.display = isChoice ? '' : 'none';
}

$('f-type').addEventListener('change', syncTypeUI);

function collectForm() {
  const options = {};
  for (const L of ['A', 'B', 'C', 'D']) {
    const v = $(`f-${L}`).value.trim();
    if (v) options[L] = v;
  }
  return {
    date: $('f-date').value.trim(),
    subject: $('f-subject').value.trim() || '综合',
    type: $('f-type').value,
    question: $('f-question').value,
    options,
    answer: $('f-answer').value,
    answerText: $('f-answerText').value,
    keyPoints: $('f-keyPoints').value.split('\n').map((s) => s.trim()).filter(Boolean),
    explanation: $('f-explanation').value,
  };
}

$('f-save').addEventListener('click', async () => {
  const msg = $('f-msg');
  msg.className = 'save-msg';
  msg.textContent = '保存中…';
  try {
    const res = await fetch('/api/admin/question', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectForm()),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存失败');
    msg.className = 'save-msg ok';
    msg.textContent = `✅ 已保存 ${data.question.date} 的题目`;
    loadList();
  } catch (e) {
    msg.className = 'save-msg bad';
    msg.textContent = `❌ ${e.message}`;
  }
});

$('f-clear').addEventListener('click', () => {
  fillForm(null);
  $('f-msg').textContent = '';
});

async function loadList() {
  try {
    const res = await fetch('/api/admin/questions');
    const list = await res.json();
    const tbody = $('q-list');
    tbody.innerHTML = '';
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">还没有题目，先添加一个吧</td></tr>';
      return;
    }
    const typeLabel = { 'single-choice': '单选', 'multi-choice': '多选', free: '主观' };
    for (const q of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${q.date}</td><td>${esc(q.subject)}</td>` +
        `<td>${typeLabel[q.type] || q.type}</td>` +
        `<td class="muted">${esc(q.question.slice(0, 40))}${q.question.length > 40 ? '…' : ''}</td>` +
        `<td><button class="link-btn">编辑</button></td>`;
      tr.querySelector('button').addEventListener('click', () => {
        fillForm(q);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      tbody.appendChild(tr);
    }
  } catch {
    $('q-list').innerHTML = '<tr><td colspan="5" class="muted">加载失败</td></tr>';
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

fillForm(null);
loadList();
