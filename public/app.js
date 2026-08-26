// 每日一题 · 小老师 —— 前端逻辑
const $ = (id) => document.getElementById(id);

const state = {
  user: localStorage.getItem('quiz-user') || '',
  date: null,
  question: null,
  selected: null, // 已选字母（选择题）
  submitted: false,
  busy: false,
  history: [], // [{role, content}]
};

const TYPE_LABEL = {
  'single-choice': '单选题',
  'multi-choice': '多选题',
  free: '主观题',
};
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

// ---------- 顶栏日期 ----------
function renderTodayChip() {
  if (!state.date) return;
  const d = new Date(`${state.date}T12:00:00+08:00`);
  $('today-chip').textContent =
    `${Number(state.date.slice(5, 7))} 月 ${Number(state.date.slice(8, 10))} 日 · 星期${WEEKDAY[d.getUTCDay()]}`;
}

// ---------- 名字 ----------
function ensureName() {
  if (state.user) {
    $('who-name').textContent = `👋 ${state.user}`;
    return;
  }
  $('name-modal').classList.remove('hidden');
  $('name-input').focus();
}
$('name-save').addEventListener('click', () => {
  const v = $('name-input').value.trim();
  if (!v) return;
  state.user = v;
  localStorage.setItem('quiz-user', v);
  $('name-modal').classList.add('hidden');
  $('who-name').textContent = `👋 ${v}`;
  loadStats();
  loadLeaderboard();
});
$('name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('name-save').click();
});
$('rename-btn').addEventListener('click', () => {
  state.user = '';
  localStorage.removeItem('quiz-user');
  ensureName();
});

// ---------- 题目 ----------
async function loadToday() {
  try {
    const res = await fetch('/api/today');
    const data = await res.json();
    if (!res.ok) {
      $('question-loading').classList.add('hidden');
      $('question-missing').classList.remove('hidden');
      return;
    }
    state.date = data.date;
    state.question = data.question;
    renderTodayChip();
    renderQuestion();
    restoreChat();
  } catch {
    $('question-loading').textContent = '加载失败，请刷新重试';
  }
}

function renderQuestion() {
  $('question-loading').classList.add('hidden');
  $('question-body').classList.remove('hidden');
  const q = state.question;

  $('q-subject').textContent = q.subject;
  $('q-type').textContent = TYPE_LABEL[q.type] || q.type;
  $('q-date').textContent = state.date;

  $('q-text').textContent = q.question;

  const isChoice = q.type === 'single-choice' || q.type === 'multi-choice';
  $('q-free-input').classList.toggle('hidden', isChoice);

  if (isChoice) {
    const box = $('q-options');
    box.innerHTML = '';
    for (const [letter, text] of Object.entries(q.options || {})) {
      const btn = document.createElement('button');
      btn.className = 'option';
      btn.dataset.letter = letter;
      btn.innerHTML = `<span class="ol">${letter}</span><span>${escapeHtml(text)}</span>`;
      btn.addEventListener('click', () => selectOption(letter));
      box.appendChild(btn);
    }
  }

  updateSubmitState();
}

function selectOption(letter) {
  if (state.submitted || state.busy) return;
  const q = state.question;
  if (q.type === 'single-choice') {
    state.selected = letter;
    document.querySelectorAll('.option').forEach((el) =>
      el.classList.toggle('selected', el.dataset.letter === letter),
    );
  } else {
    // 多选：维护一个集合
    const set = new Set(state.selected || []);
    if (set.has(letter)) set.delete(letter);
    else set.add(letter);
    state.selected = [...set].sort().join('');
    document.querySelectorAll('.option').forEach((el) =>
      el.classList.toggle('selected', set.has(el.dataset.letter)),
    );
  }
  updateSubmitState();
}

function currentAnswer() {
  const q = state.question;
  if (!q) return '';
  if (q.type === 'free') return $('q-free-input').value.trim();
  return state.selected || '';
}

function updateSubmitState() {
  $('submit-btn').disabled = state.busy || !currentAnswer();
}
$('q-free-input').addEventListener('input', updateSubmitState);

$('submit-btn').addEventListener('click', () => {
  const answer = currentAnswer();
  if (!answer) return;
  ask(`【提交答案】${answer}`);
});

// ---------- 判定展示 ----------
function showVerdict(v) {
  state.submitted = true;
  const el = $('verdict');
  el.classList.remove('hidden', 'ok', 'bad');
  el.classList.add(v.correct ? 'ok' : 'bad');
  el.innerHTML =
    `<div class="v-title">${v.correct ? '✅ 答对了！' : '❌ 还差一点，再试试'}</div>` +
    `<div class="v-sub">${escapeHtml(v.comment || '')}</div>` +
    `<div class="v-note">今天第 ${v.attemptNo} 次作答 · ${v.correct ? '看看小老师的讲解 →' : '可以继续提交，也可以问小老师要提示'}</div>`;

  // 选择题：锁定并标注用户所选
  const q = state.question;
  if (q && q.options) {
    document.querySelectorAll('.option').forEach((el) => {
      el.classList.add('locked');
      el.classList.remove('selected');
    });
    const letters = String(currentAnswer() || '').split('');
    for (const l of letters) {
      const el = document.querySelector(`.option[data-letter="${l}"]`);
      if (el) el.classList.add(v.correct ? 'correct' : 'wrong');
    }
  }
  loadStats();
  loadLeaderboard();
}

// ---------- 聊天 ----------
function addMsg(role, text, cls = '') {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'student' : 'teacher'} ${cls}`;
  div.textContent = text;
  $('chat-log').appendChild(div);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  return div;
}

function addTyping() {
  const div = document.createElement('div');
  div.className = 'msg teacher typing';
  div.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  $('chat-log').appendChild(div);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  return div;
}

function restoreChat() {
  try {
    const saved = JSON.parse(localStorage.getItem(`chat-${state.date}-${state.user}`) || '[]');
    for (const m of saved.slice(-20)) {
      addMsg(m.role, m.content);
      state.history.push(m);
    }
  } catch { /* 忽略坏数据 */ }
}

function persistChat() {
  try {
    localStorage.setItem(
      `chat-${state.date}-${state.user}`,
      JSON.stringify(state.history.slice(-20)),
    );
  } catch { /* 存储满等情况忽略 */ }
}

async function ask(message) {
  if (state.busy || !message.trim()) return;
  state.busy = true;
  updateSubmitState();
  $('chat-send').disabled = true;

  addMsg('user', message);
  const typing = addTyping();
  let live = null;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: state.user, message, history: state.history.slice(-12) }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败 (${res.status})`);
    }

    // 解析 SSE 流
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        const evLine = part.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
        if (!evLine || !dataLine) continue;
        const event = evLine.slice(7).trim();
        const data = JSON.parse(dataLine.slice(6));

        if (event === 'text') {
          if (!live) {
            typing.remove();
            live = addMsg('teacher', '');
          }
          text += data.t;
          live.textContent = text;
          $('chat-log').scrollTop = $('chat-log').scrollHeight;
        } else if (event === 'verdict') {
          showVerdict(data);
        } else if (event === 'error') {
          throw new Error(data.message);
        }
      }
    }

    typing.remove();
    state.history.push({ role: 'user', content: message });
    if (text) state.history.push({ role: 'assistant', content: text });
    persistChat();
  } catch (e) {
    typing.remove();
    addMsg('teacher', `⚠️ ${e.message}`, 'error');
  } finally {
    state.busy = false;
    updateSubmitState();
    $('chat-send').disabled = false;
  }
}

$('chat-send').addEventListener('click', () => {
  const t = $('chat-text').value.trim();
  if (!t) return;
  $('chat-text').value = '';
  ask(t);
});
$('chat-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('chat-send').click();
  }
});

// ---------- 统计 ----------
async function loadStats() {
  if (!state.user) return;
  try {
    const res = await fetch(`/api/stats?user=${encodeURIComponent(state.user)}`);
    if (!res.ok) return;
    const s = await res.json();
    const today = s.days.find((d) => d.date === state.date);
    $('st-today').textContent = today ? today.attempts : 0;
    $('st-correct').textContent = s.correctDays;
    $('st-streak').textContent = s.streak;
  } catch { /* 静默 */ }
}

// ---------- 排行榜 ----------
async function loadLeaderboard() {
  try {
    const url = state.user
      ? `/api/leaderboard?user=${encodeURIComponent(state.user)}`
      : '/api/leaderboard';
    const res = await fetch(url);
    if (!res.ok) return;
    const board = await res.json();
    renderLeaderboard(board);
  } catch { /* 静默 */ }
}

function renderLeaderboard(board) {
  const list = $('lb-list');
  list.innerHTML = '';

  if (!board.leaders.length) {
    list.innerHTML = '<div class="muted lb-empty">还没有人上榜，今天从你开始</div>';
    $('lb-me').classList.add('hidden');
    return;
  }

  const medal = { 1: '🥇', 2: '🥈', 3: '🥉' };
  for (const row of board.leaders) {
    const isMe = state.user && row.user === state.user;
    const div = document.createElement('div');
    div.className = `lb-row${isMe ? ' me' : ''}`;

    const rankCls = row.rank <= 3 ? ` r${row.rank}` : '';
    const rankHtml = medal[row.rank]
      ? `<span title="第 ${row.rank} 名">${medal[row.rank]}</span>`
      : row.rank;

    const todayPill = row.today.correct
      ? '<span class="lb-today ok">今日 ✅</span>'
      : row.today.attempted
        ? '<span class="lb-today wait">今日已答</span>'
        : '';

    div.innerHTML =
      `<div class="lb-rank${rankCls}">${rankHtml}</div>` +
      `<div class="lb-name">${escapeHtml(row.user)}${isMe ? '<span class="muted">（我）</span>' : ''}</div>` +
      `<div class="lb-stats">` +
      `<span>答对 <b>${row.correctDays}</b> 天</span>` +
      `<span title="连续答对">🔥 <b>${row.streak}</b></span>` +
      todayPill +
      `</div>`;
    list.appendChild(div);
  }

  // “我的名次”（不在前 10 时显示）
  const me = $('lb-me');
  if (board.me && board.me.rank > board.leaders.length) {
    me.textContent = `我的名次：第 ${board.me.rank} 名 · 答对 ${board.me.correctDays} 天 · 🔥 ${board.me.streak}`;
    me.classList.remove('hidden');
  } else {
    me.classList.add('hidden');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// ---------- 启动 ----------
ensureName();
loadToday();
loadStats();
loadLeaderboard();
// 排行榜轻量轮询：别人答题后也能看到变化
setInterval(loadLeaderboard, 60_000);
