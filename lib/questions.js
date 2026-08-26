// 题目存储：questions/<YYYY-MM-DD>.json，一天一题
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidDateStr } from './date.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const QDIR = process.env.QUIZ_QUESTIONS_DIR
  ? path.resolve(process.env.QUIZ_QUESTIONS_DIR)
  : path.join(ROOT, 'questions');

export const QUESTION_TYPES = ['single-choice', 'multi-choice', 'free'];

function questionPath(date) {
  return path.join(QDIR, `${date}.json`);
}

export function getQuestion(date) {
  const p = questionPath(date);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function listQuestionDates() {
  if (!fs.existsSync(QDIR)) return [];
  return fs
    .readdirSync(QDIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

function normalizeAnswer(answer) {
  return String(answer ?? '')
    .toUpperCase()
    .replace(/[^A-H]/g, '')
    .split('')
    .filter((c, i, arr) => arr.indexOf(c) === i)
    .sort()
    .join('');
}

// 校验并清洗题目对象；不合法时抛错（中文消息直接可给用户看）
export function validateQuestion(input) {
  const errors = [];
  const date = input?.date;
  if (!isValidDateStr(date)) errors.push('date 必须是 YYYY-MM-DD 格式');

  const type = input?.type;
  if (!QUESTION_TYPES.includes(type)) errors.push(`type 必须是 ${QUESTION_TYPES.join(' / ')} 之一`);

  const question = String(input?.question ?? '').trim();
  if (!question) errors.push('question 不能为空');
  if (question.length > 2000) errors.push('question 过长（>2000 字符）');

  const subject = String(input?.subject ?? '综合').trim().slice(0, 24) || '综合';

  let options = null;
  let answer = String(input?.answer ?? '').trim();

  if (type === 'single-choice' || type === 'multi-choice') {
    options = {};
    const raw = input?.options ?? {};
    for (const letter of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const text = String(raw[letter] ?? '').trim();
      if (text) options[letter] = text.slice(0, 500);
    }
    if (Object.keys(options).length < 2) errors.push('选择题至少需要 2 个选项');
    answer = normalizeAnswer(answer);
    if (!answer) errors.push('answer 不能为空');
    else if (![...answer].every((l) => options[l])) errors.push(`answer 中的字母 ${answer} 不在给定选项里`);
    else if (type === 'single-choice' && answer.length !== 1) errors.push('单选题 answer 只能是一个字母');
  } else if (type === 'free') {
    if (!answer) errors.push('answer（参考答案）不能为空');
    if (answer.length > 2000) errors.push('answer 过长（>2000 字符）');
  }

  const keyPoints = Array.isArray(input?.keyPoints)
    ? input.keyPoints.map((k) => String(k).trim()).filter(Boolean).slice(0, 10)
    : [];
  const explanation = String(input?.explanation ?? '').trim().slice(0, 4000);
  const answerText = String(input?.answerText ?? '').trim().slice(0, 500);

  if (errors.length) throw new Error(errors.join('；'));

  return { date, subject, type, question, options, answer, answerText, keyPoints, explanation };
}

export function saveQuestion(input) {
  const q = validateQuestion(input);
  fs.mkdirSync(QDIR, { recursive: true });
  fs.writeFileSync(questionPath(q.date), JSON.stringify(q, null, 2) + '\n', 'utf8');
  return q;
}

// 给前端的公开视图：绝不包含 answer / keyPoints / explanation / answerText
export function publicView(q) {
  return {
    date: q.date,
    subject: q.subject,
    type: q.type,
    question: q.question,
    options: q.options ?? null,
  };
}
