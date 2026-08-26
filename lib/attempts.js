// 答题记录存储：data/attempts.json -> { "<date>": [ {user, answer, correct, comment, at} ] }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayStr } from './date.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = process.env.QUIZ_DATA_DIR
  ? path.join(path.resolve(process.env.QUIZ_DATA_DIR), 'attempts.json')
  : path.join(ROOT, 'data', 'attempts.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2) + '\n', 'utf8');
}

export function recordAttempt(date, entry) {
  const db = load();
  if (!Array.isArray(db[date])) db[date] = [];
  db[date].push({
    user: entry.user,
    answer: entry.answer,
    correct: Boolean(entry.correct),
    comment: entry.comment ?? '',
    at: new Date().toISOString(),
  });
  save(db);
  return db[date].length;
}

export function getAttempts(date) {
  const db = load();
  return Array.isArray(db[date]) ? db[date] : [];
}

export function todaysAttemptsForUser(user, date = todayStr()) {
  return getAttempts(date).filter((a) => a.user === user);
}

// 连续答对天数：从今天（或昨天）起算，今天未答对不断记录
function streakFromOkDates(okDates, today) {
  const okSet = new Set(okDates);
  let cursor = today;
  if (!okSet.has(cursor)) {
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    cursor = d.toISOString().slice(0, 10);
  }
  let streak = 0;
  while (okSet.has(cursor)) {
    streak += 1;
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    cursor = d.toISOString().slice(0, 10);
  }
  return streak;
}

// 某用户维度的统计：每天作答次数 / 是否答对 / 总天数 / 连续答对天数
export function userStats(user) {
  const db = load();
  const dates = Object.keys(db).sort().reverse();
  const days = dates.map((date) => {
    const mine = db[date].filter((a) => a.user === user);
    return {
      date,
      attempts: mine.length,
      correct: mine.some((a) => a.correct),
    };
  });

  return {
    days,
    attemptedDays: days.filter((d) => d.attempts > 0).length,
    correctDays: days.filter((d) => d.correct).length,
    streak: streakFromOkDates(days.filter((d) => d.correct).map((d) => d.date), todayStr()),
  };
}

// 全员排行榜：按 累计答对天数 > 连续天数 > 参与天数 排序
export function leaderboard({ date = todayStr(), limit = 10 } = {}) {
  const db = load();
  const byUser = new Map();

  for (const [d, entries] of Object.entries(db)) {
    for (const e of entries) {
      if (!e.user) continue;
      if (!byUser.has(e.user)) byUser.set(e.user, new Map());
      const days = byUser.get(e.user);
      const day = days.get(d) || { attempts: 0, correct: false };
      day.attempts += 1;
      day.correct = day.correct || Boolean(e.correct);
      days.set(d, day);
    }
  }

  const rows = [...byUser.entries()].map(([user, days]) => {
    const okDates = [...days.entries()].filter(([, v]) => v.correct).map(([d]) => d);
    const todayRow = days.get(date);
    return {
      user,
      attemptedDays: days.size,
      correctDays: okDates.length,
      streak: streakFromOkDates(okDates, date),
      today: { attempted: Boolean(todayRow), correct: Boolean(todayRow?.correct) },
    };
  });

  rows.sort(
    (a, b) =>
      b.correctDays - a.correctDays ||
      b.streak - a.streak ||
      (b.today.correct ? 1 : 0) - (a.today.correct ? 1 : 0) ||
      b.attemptedDays - a.attemptedDays ||
      a.user.localeCompare(b.user, 'zh'),
  );

  const ranked = rows.map((r, i) => ({ rank: i + 1, ...r }));
  return { date, leaders: ranked.slice(0, limit), total: ranked.length, all: ranked };
}
