#!/usr/bin/env node
// 命令行加题示例：
//   node scripts/add-question.js --date 2026-09-02 --subject "Graph · 多智能体" --type single-choice \
//     --question "题干" --A "选项A" --B "选项B" --C "选项C" --D "选项D" --answer C \
//     --keyPoints "要点1" --keyPoints "要点2" --explanation "解析"
import { saveQuestion } from '../lib/questions.js';
import { todayStr } from '../lib/date.js';

function parseArgs(argv) {
  const out = { options: {}, keyPoints: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    if (key === 'keyPoints') out.keyPoints.push(val);
    else if (['A', 'B', 'C', 'D', 'E', 'F'].includes(key)) out.options[key] = val;
    else out[key] = val;
    i++;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.question) {
  console.log('用法见文件头部注释；至少需要 --question');
  process.exit(1);
}

try {
  const q = saveQuestion({
    date: args.date || todayStr(),
    subject: args.subject || '综合',
    type: args.type || 'single-choice',
    question: args.question,
    options: args.options,
    answer: args.answer || '',
    answerText: args.answerText || '',
    keyPoints: args.keyPoints,
    explanation: args.explanation || '',
  });
  console.log(`✅ 已保存 ${q.date} 的题目：${q.question.slice(0, 40)}…`);
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
