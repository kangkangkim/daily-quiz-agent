// 每日一题 · 康康小老师 —— 前端逻辑（v2：实时榜 + 领奖台）
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

const prevRanks = new Map(); // user -> 上次名次，用于“名次变化”高亮

const TYPE_LABEL = {
  'single-choice': '单选题',
  'multi-choice': '多选题',
  free: '主观题',
};
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

// ---------- 顶栏日期 + Hero ----------
function renderTodayChip(data) {
  if (!state.date) return;
  const d = new Date(`${state.date}T12:00:00+08:00`);
  const dateText =
    `${Number(state.date.slice(5, 7))} 月 ${Number(state.date.slice(8, 10))} 日 · 星期${WEEKDAY[d.getUTCDay()]}`;
  $('today-chip').textContent = dateText;
  $('hero-date').textContent = dateText + (data?.issueNo ? ` · 每天 0 点更新` : '');
  if (data?.issueNo != null) $('issue-no').textContent = data.issueNo;
  if (data?.participantsToday != null) $('hn-part').textContent = data.participantsToday;
  if (data?.correctToday != null) $('hn-ok').textContent = data.correctToday;
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
      $('hero-date').textContent = '今天还没有题目';
      return;
    }
    state.date = data.date;
    state.question = data.question;
    renderTodayChip(data);
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
    `<div class="v-note">今天第 ${v.attemptNo} 次作答 · ${v.correct ? '看看康康的讲解 →' : '可以继续提交，也可以问康康要提示'}</div>`;

  if (v.correct) celebrate();

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

// ---------- 撒花 ----------
function celebrate() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#f4502e', '#ff8a3d', '#ffb020', '#0fa396', '#7b6cf0'];
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('span');
    p.className = 'confetti-piece' + (Math.random() < 0.3 ? ' round' : '');
    p.style.left = `${4 + Math.random() * 92}vw`;
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = `${1.4 + Math.random() * 1.1}s`;
    p.style.animationDelay = `${Math.random() * 0.3}s`;
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    document.body.appendChild(p);
    p.addEventListener('animationend', () => p.remove());
  }
}

// ---------- 聊天 ----------
// 轻量 Markdown 渲染：先整体转义，再把安全的子集（标题/表格/列表/加粗/行内代码）
// 转成结构标签 —— 康康的回复常带表格和要点，纯文本会满屏竖线
function mdInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderRich(text) {
  // 先整体 HTML 转义，再在转义后的文本上做安全的结构转换
  const lines = escapeHtml(String(text ?? '')).split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let table = false;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (table) { out.push('</tbody></table>'); table = false; } };

  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { closeList(); closeTable(); continue; }

    // 表格行 | a | b |
    if (/^\|.*\|$/.test(l)) {
      const cells = l.slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue; // 分隔行丢弃
      if (!table) {
        closeList();
        out.push('<table><tbody>');
        table = true;
        out.push('<tr>' + cells.map((c) => `<th>${mdInline(c)}</th>`).join('') + '</tr>');
        continue;
      }
      out.push('<tr>' + cells.map((c) => `<td>${mdInline(c)}</td>`).join('') + '</tr>');
      continue;
    }
    closeTable();

    // 标题
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<div class="md-h md-h${h[1].length}">${mdInline(h[2])}</div>`); continue; }

    // 列表
    if (/^[-*•]\s+/.test(l)) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${mdInline(l.replace(/^[-*•]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\d+[.、)]\s+/.test(l)) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${mdInline(l.replace(/^\d+[.、)]\s+/, ''))}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${mdInline(l)}</p>`);
  }
  closeList();
  closeTable();
  return out.join('') || '<p></p>';
}

function addMsg(role, text, cls = '') {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'student' : 'teacher'} ${cls}`;
  if (role === 'user') div.textContent = text;
  else div.innerHTML = renderRich(text);
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
          live.innerHTML = renderRich(text);
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

// ---------- 我的统计 ----------
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

function renderHeroNums(board) {
  if (board.participantsToday != null) $('hn-part').textContent = board.participantsToday;
  if (board.correctToday != null) $('hn-ok').textContent = board.correctToday;
}

function renderPodium(leaders) {
  const podium = $('podium');
  podium.innerHTML = '';
  if (!leaders.length) return;

  const medal = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const top = leaders.slice(0, 3);
  const order = [top[1], top[0], top[2]].filter(Boolean); // 视觉顺序：2 - 1 - 3
  for (const row of order) {
    const div = document.createElement('div');
    div.className = `pd p${row.rank}${state.user && row.user === state.user ? ' me' : ''}`;
    const initial = [...row.user][0] ?? '·';
    const todayPill = row.today.correct
      ? ' <span class="lb-today ok">今日 ✅</span>'
      : row.today.attempted
        ? ' <span class="lb-today wait">今日已答</span>'
        : '';
    div.innerHTML =
      `<div class="pd-medal">${medal[row.rank]}</div>` +
      `<div class="pd-avatar">${escapeHtml(initial)}</div>` +
      `<div class="pd-name">${escapeHtml(row.user)}</div>` +
      `<div class="pd-days">答对 <b>${row.correctDays}</b> 天 · 🔥 <b>${row.streak}</b>${todayPill}</div>` +
      `<div class="pd-bar"></div>`;
    podium.appendChild(div);
  }
}

function renderLeaderboard(board) {
  renderHeroNums(board);
  renderPodium(board.leaders);

  const list = $('lb-list');
  list.innerHTML = '';

  const rest = board.leaders.slice(3);
  if (!board.leaders.length) {
    list.innerHTML = '<div class="muted lb-empty">还没有人上榜，今天从你开始</div>';
    $('lb-me').classList.add('hidden');
    return;
  }

  for (const row of rest) {
    const isMe = state.user && row.user === state.user;
    const div = document.createElement('div');
    // 名次变化（新上榜或排名变动）→ 闪烁提示
    const changed = prevRanks.has(row.user) && prevRanks.get(row.user) !== row.rank;
    const fresh = !prevRanks.has(row.user) && prevRanks.size > 0;
    div.className = `lb-row${isMe ? ' me' : ''}${changed || fresh ? ' flash' : ''}`;

    const todayPill = row.today.correct
      ? '<span class="lb-today ok">今日 ✅</span>'
      : row.today.attempted
        ? '<span class="lb-today wait">今日已答</span>'
        : '';

    div.innerHTML =
      `<div class="lb-rank">${row.rank}</div>` +
      `<div class="lb-name">${escapeHtml(row.user)}${isMe ? '<span class="muted">（我）</span>' : ''}</div>` +
      `<div class="lb-stats">` +
      `<span>答对 <b>${row.correctDays}</b> 天</span>` +
      `<span title="连续答对">🔥 <b>${row.streak}</b></span>` +
      todayPill +
      `</div>`;
    list.appendChild(div);
  }
  if (!rest.length) list.classList.add('hidden');
  else list.classList.remove('hidden');

  for (const row of board.leaders) prevRanks.set(row.user, row.rank);

  // “我的名次”（不在前 10 时显示）
  const me = $('lb-me');
  if (board.me && board.me.rank > board.leaders.length) {
    me.textContent = `我的名次：第 ${board.me.rank} 名 · 答对 ${board.me.correctDays} 天 · 🔥 ${board.me.streak}`;
    me.classList.remove('hidden');
  } else {
    me.classList.add('hidden');
  }
}

// ---------- 实时榜：SSE 订阅 + 兜底轮询 ----------
function setLivePill(on) {
  $('live-pill').classList.toggle('off', !on);
  $('live-label').textContent = on ? '实时榜' : '已断开 · 轮询中';
}

function connectBoardStream() {
  if (!('EventSource' in window)) {
    setLivePill(false);
    setInterval(loadLeaderboard, 30_000);
    return;
  }
  const es = new EventSource('/api/leaderboard/stream');
  es.addEventListener('open', () => setLivePill(true));
  es.addEventListener('board', (e) => {
    try {
      renderLeaderboard(JSON.parse(e.data));
    } catch { /* 坏帧忽略 */ }
  });
  es.addEventListener('error', () => {
    // 浏览器会自动重连；期间用轮询兜底
    setLivePill(false);
    loadLeaderboard();
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// ---------- 往期回顾（历史题目 + 答案 + 解析；今日题不进历史，防剧透） ----------
const historyState = { loaded: false, open: new Set(), pendingOpen: false, pendingDate: null };

async function loadHistory(force = false) {
  if (historyState.loaded && !force) return;
  try {
    const res = await fetch('/api/history');
    if (!res.ok) return;
    const { items } = await res.json();
    historyState.loaded = true;
    historyState.items = items;
    $('history-count').textContent = items.length ? `共 ${items.length} 期` : '';
    renderHistory(items);
    // 深链 open=1 / open=YYYY-MM-DD：自动展开最近一期或指定日期（分享/测试用）
    const target =
      historyState.pendingOpen === 'date'
        ? historyState.pendingDate
        : historyState.pendingOpen
          ? items[0]?.date
          : null;
    historyState.pendingOpen = false;
    historyState.pendingDate = null;
    if (target && items.some((i) => i.date === target)) {
      historyState.open.add(target);
      renderHistory(items);
    }
  } catch { /* 静默 */ }
}

function renderHistory(items) {
  const body = $('history-body');
  body.innerHTML = '';
  if (!items.length) {
    body.innerHTML = '<div class="muted" style="padding:6px 2px">还没有往期题目</div>';
    return;
  }
  items.forEach((q, idx) => {
    const no = q.issueNo ?? idx + 1;
    const item = document.createElement('div');
    item.className = 'h-item';
    const open = historyState.open.has(q.date);

    const head = document.createElement('button');
    head.className = 'h-item-head';
    head.setAttribute('aria-expanded', String(open));
    head.innerHTML =
      `<span class="h-no">${no}</span>` +
      `<span class="h-meta"><b>${escapeHtml(q.subject)}</b>` +
      `<span class="muted h-date">${q.date} · ${TYPE_LABEL[q.type] || q.type}</span></span>` +
      `<span class="history-arrow" aria-hidden="true">${open ? '▾' : '▸'}</span>`;
    head.addEventListener('click', () => {
      if (historyState.open.has(q.date)) historyState.open.delete(q.date);
      else historyState.open.add(q.date);
      renderHistory(items);
    });
    item.appendChild(head);

    if (open) {
      const detail = document.createElement('div');
      detail.className = 'h-detail';
      const options = q.options
        ? Object.entries(q.options)
            .map(([letter, text]) =>
              `<div class="h-option${String(q.answer).includes(letter) ? ' hit' : ''}">` +
              `<span class="ol">${letter}</span><span>${escapeHtml(text)}</span></div>`,
            )
            .join('')
        : '';
      const keyPoints = q.keyPoints?.length
        ? '<div class="md-h md-h3">考察要点</div><ul>' +
          q.keyPoints.map((k) => `<li>${escapeHtml(k)}</li>`).join('') +
          '</ul>'
        : '';
      detail.innerHTML =
        `<div class="h-question">${escapeHtml(q.question)}</div>` +
        options +
        `<div class="h-answer"><span class="h-answer-tag">答案</span>${escapeHtml(q.answerText || q.answer)}</div>` +
        keyPoints +
        (q.explanation
          ? '<div class="md-h md-h3">解析</div><div class="h-explain">' + renderRich(q.explanation) + '</div>'
          : '');
      item.appendChild(detail);
    }
    body.appendChild(item);
  });
}

$('history-toggle').addEventListener('click', async () => {
  const body = $('history-body');
  const open = body.classList.toggle('hidden');
  $('history-toggle').setAttribute('aria-expanded', String(!open));
  $('history-arrow').textContent = open ? '▸' : '▾';
  if (!open) loadHistory();
});

// ---------- 知识图谱：题库沿知识脉络动态生长 ----------
const G = { canvas: null, ctx: null, w: 0, h: 0, dpr: 1, hubs: [], leaves: [], hover: null, raf: 0, t0: 0 };
const HUB_COLORS = ['#f4502e', '#ffb020', '#0fa396', '#7b6cf0', '#ff8a3d'];
const STATUS_COLOR = { past: '#0fa396', today: '#f4502e', future: '#b9b0a2' };
const STATUS_TEXT = { past: '已解锁', today: '今日', future: '待解锁' };
const graphRnd = (i) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function layoutGraph() {
  const { w, h } = G;
  const cx = w / 2;
  const cy = h / 2 + 4;
  const N = Math.max(G.hubs.length, 1);
  const rx = Math.min(w * 0.3, 290);
  const ry = Math.min(h * 0.3, 88);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  G.hubs.forEach((hub, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    hub.bx = clamp(cx + Math.cos(ang) * rx, 40, w - 40);
    hub.by = clamp(cy + Math.sin(ang) * ry, 26, h - 34);
  });
  G.leaves.forEach((leaf) => {
    const hub = leaf.hub;
    const toward = Math.atan2(cy - hub.by, cx - hub.bx); // 朝画布中心展开
    const n = Math.max(hub.leaves.length, 1);
    const spread = Math.min(Math.PI * 1.5, 0.95 * n);
    const ang =
      toward + (n === 1 ? 0 : -spread / 2 + (spread * leaf.idx) / (n - 1));
    const r = 46 + graphRnd(leaf.seed) * 16;
    leaf.bx = clamp(hub.bx + Math.cos(ang) * r, 20, w - 20);
    leaf.by = clamp(hub.by + Math.sin(ang) * r, 20, h - 20);
  });
}

function buildGraphNodes(data) {
  G.hubs = [];
  G.leaves = [];
  let seed = 0;
  data.subjects.forEach((s, i) => {
    const hub = {
      kind: 'hub',
      id: 'hub-' + i,
      label: s.label,
      color: HUB_COLORS[i % HUB_COLORS.length],
      leaves: [],
      phase: graphRnd(seed++) * Math.PI * 2,
      amp: 2.5 + graphRnd(seed++) * 1.5,
      speed: 0.5 + graphRnd(seed++) * 0.4,
      r: 13,
    };
    G.hubs.push(hub);
    s.items.forEach((it, k) => {
      const leaf = {
        kind: 'leaf',
        id: 'q-' + it.date,
        label: it.label,
        subject: s.subject,
        date: it.date,
        issueNo: it.issueNo,
        status: it.status,
        hub,
        idx: k,
        of: s.items.length,
        seed: seed + k * 7,
        phase: graphRnd(seed++) * Math.PI * 2,
        amp: 3 + graphRnd(seed++) * 3,
        speed: 0.6 + graphRnd(seed++) * 0.5,
        r: it.status === 'today' ? 7 : 6,
        hash: graphRnd(seed++),
      };
      hub.leaves.push(leaf);
      G.leaves.push(leaf);
    });
    seed += 3;
  });
}

function drawGraph() {
  const ctx = G.ctx;
  if (!ctx) return;
  const t = (performance.now() - G.t0) / 1000;
  G.t = t;
  const place = (n) => {
    n.x = n.bx + Math.sin(t * n.speed + n.phase) * n.amp;
    n.y = n.by + Math.cos(t * n.speed * 0.83 + n.phase * 1.7) * n.amp;
  };
  G.hubs.forEach(place);
  G.leaves.forEach(place);

  ctx.clearRect(0, 0, G.w, G.h);

  // 学习路径（科目间虚线，dash 流动）
  if (G.hubs.length > 1) {
    ctx.save();
    ctx.strokeStyle = 'rgba(43,38,32,0.16)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 7]);
    ctx.lineDashOffset = -t * 14;
    ctx.beginPath();
    G.hubs.forEach((hb, i) => (i ? ctx.lineTo(hb.x, hb.y) : ctx.moveTo(hb.x, hb.y)));
    ctx.stroke();
    ctx.restore();
  }

  // 科目 → 题目 的边
  G.leaves.forEach((leaf) => {
    const hub = leaf.hub;
    const isToday = leaf.status === 'today';
    ctx.strokeStyle = isToday ? 'rgba(244,80,46,0.4)' : 'rgba(43,38,32,0.1)';
    ctx.lineWidth = isToday ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(hub.x, hub.y);
    ctx.lineTo(leaf.x, leaf.y);
    ctx.stroke();
  });

  // 游走光点（已解锁/今日的边上才有）
  G.leaves.forEach((leaf) => {
    if (leaf.status === 'future') return;
    const hub = leaf.hub;
    const p = (t * 0.16 + leaf.hash) % 1;
    for (let g = 0; g < 3; g++) {
      const pp = p - g * 0.045;
      if (pp < 0 || pp > 1) continue;
      const x = hub.x + (leaf.x - hub.x) * pp;
      const y = hub.y + (leaf.y - hub.y) * pp;
      ctx.globalAlpha = (1 - g * 0.35) * 0.85;
      ctx.fillStyle = leaf.status === 'today' ? '#ff8a3d' : '#ffb020';
      ctx.beginPath();
      ctx.arc(x, y, 2.4 - g * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });

  // 节点
  ctx.font = '11px system-ui, -apple-system, "PingFang SC", sans-serif';
  G.hubs.forEach((hub) => {
    ctx.beginPath();
    ctx.fillStyle = hub.color + '24';
    ctx.arc(hub.x, hub.y, hub.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hub.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.fillStyle = hub.color;
    ctx.arc(hub.x, hub.y, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(43,38,32,0.85)';
    ctx.font = '600 11px system-ui, -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(hub.label, hub.x, hub.y + hub.r + 14);
  });

  G.leaves.forEach((leaf) => {
    const hovered = G.hover === leaf;
    const r = leaf.r + (hovered ? 1.6 : 0);
    if (leaf.status === 'today') {
      const halo = r + 5 + Math.sin(t * 2.6) * 2.4;
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(244,80,46,0.5)';
      ctx.lineWidth = 1.4;
      ctx.arc(leaf.x, leaf.y, halo, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = '#f4502e';
      ctx.arc(leaf.x, leaf.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (leaf.status === 'past') {
      ctx.beginPath();
      ctx.fillStyle = '#0fa396';
      ctx.arc(leaf.x, leaf.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.4;
      ctx.moveTo(leaf.x - 2.6, leaf.y);
      ctx.lineTo(leaf.x - 0.6, leaf.y + 2.2);
      ctx.lineTo(leaf.x + 2.8, leaf.y - 2.4);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.strokeStyle = '#b9b0a2';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 3]);
      ctx.arc(leaf.x, leaf.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = (leaf.status === 'today' ? '700 ' : '') + '10.5px system-ui, -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle =
      leaf.status === 'today' ? '#f4502e' : leaf.status === 'past' ? 'rgba(43,38,32,0.72)' : 'rgba(43,38,32,0.4)';
    // 下半区的叶子标签画在节点上方，避免压到下方的中心节点
    const labelY = leaf.y < G.h * 0.6 ? leaf.y + r + 12 : leaf.y - r - 7;
    ctx.fillText(leaf.label, leaf.x, labelY);
  });
}

function graphTick() {
  drawGraph();
  G.raf = requestAnimationFrame(graphTick);
}

function graphHit(mx, my) {
  let best = null;
  let bestD = 16;
  [...G.leaves, ...G.hubs].forEach((n) => {
    const d = Math.hypot(n.x - mx, n.y - my);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  });
  return best;
}

function openHistoryDate(date) {
  const body = $('history-body');
  if (body.classList.contains('hidden')) {
    historyState.pendingOpen = 'date';
    historyState.pendingDate = date;
    $('history-toggle').click();
    return;
  }
  if (!historyState.loaded) return;
  historyState.open.add(date);
  renderHistory(historyState.items);
  body.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loadGraph() {
  const canvas = $('graph-canvas');
  if (!canvas) return;
  try {
    const res = await fetch('/api/graph');
    if (!res.ok) return;
    const data = await res.json();
    buildGraphNodes(data);
    G.canvas = canvas;
    G.ctx = canvas.getContext('2d');
    G.dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const wrap = canvas.parentElement;
      const rect = wrap.getBoundingClientRect();
      G.w = Math.max(300, rect.width);
      G.h = Math.max(220, rect.height);
      canvas.width = G.w * G.dpr;
      canvas.height = G.h * G.dpr;
      G.ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
      if (G.hubs.length) {
        layoutGraph();
        drawGraph();
      } else {
        G.ctx.font = '12px system-ui, sans-serif';
        G.ctx.fillStyle = 'rgba(43,38,32,0.4)';
        G.ctx.textAlign = 'center';
        G.ctx.fillText('图谱将随题库一起生长 🌱', G.w / 2, G.h / 2);
      }
    };
    resize();
    if (!G.hubs.length) return;
    new ResizeObserver(() => requestAnimationFrame(resize)).observe(canvas.parentElement);

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const n = graphHit(e.clientX - rect.left, e.clientY - rect.top);
      G.hover = n;
      canvas.style.cursor = n && n.kind === 'leaf' ? 'pointer' : 'default';
      const tip = $('graph-tip');
      if (!n) {
        tip.classList.add('hidden');
        return;
      }
      tip.innerHTML =
        n.kind === 'hub'
          ? `<b>${escapeHtml(n.label)}</b><div class="muted">${n.leaves.length} 个知识点</div>`
          : `<b>第${n.issueNo}期</b> · ${n.date} · ${STATUS_TEXT[n.status]}<div class="muted">${escapeHtml(n.subject)}</div>`;
      tip.classList.remove('hidden');
      const wrap = canvas.parentElement.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const x = Math.min(Math.max(e.clientX - wrap.left + 12, 6), wrap.width - tw - 6);
      tip.style.left = x + 'px';
      tip.style.top = Math.max(e.clientY - wrap.top - 44, 4) + 'px';
    });
    canvas.addEventListener('mouseleave', () => {
      G.hover = null;
      $('graph-tip').classList.add('hidden');
    });
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const n = graphHit(e.clientX - rect.left, e.clientY - rect.top);
      if (!n || n.kind !== 'leaf') return;
      if (n.status === 'past') openHistoryDate(n.date);
      else if (n.status === 'today') $('question-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    G.t0 = performance.now();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      drawGraph(); // 静态一帧
    } else {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) cancelAnimationFrame(G.raf);
        else if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
          cancelAnimationFrame(G.raf);
          G.raf = requestAnimationFrame(graphTick);
        }
      });
      G.raf = requestAnimationFrame(graphTick);
    }
  } catch { /* 静默 */ }
}

// ---------- 启动 ----------
// 支持 #name=xx / #history=1 深链（便于测试/分享），随后清掉 hash
{
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const hashName = params.get('name');
  if (hashName) {
    state.user = hashName.trim().slice(0, 24);
    localStorage.setItem('quiz-user', state.user);
  }
  const openParam = params.get('open');
  if (openParam === '1') historyState.pendingOpen = true;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(openParam ?? '')) {
    historyState.pendingOpen = 'date';
    historyState.pendingDate = openParam;
  }
  if (params.get('history') === '1' || historyState.pendingOpen) $('history-toggle').click();
  if (hashName) history.replaceState(null, '', location.pathname);
}
ensureName();
loadToday();
loadStats();
loadGraph();
loadLeaderboard();
connectBoardStream();
setInterval(loadLeaderboard, 120_000); // 低频兜底：SSE 静默丢失时也能追上
