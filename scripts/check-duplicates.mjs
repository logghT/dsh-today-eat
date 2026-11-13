#!/usr/bin/env node
/**
 * 菜谱重复检查（只读）。
 *
 * 用法：
 *   node scripts/check-duplicates.mjs            # 摘要
 *   node scripts/check-duplicates.mjs --strict   # 有同名菜时 exit 1（可用于发布前门禁）
 *   node scripts/check-duplicates.mjs --write docs/duplicate-audit.md
 *
 * 检查三类：
 *   1) 同名（去空格/标点后完全相同）——最可能是重复；
 *   2) 高度相似菜名（包含关系或编辑距离相似度 >= 0.8）——可能是地区变体；
 *   3) 菜谱食材集合完全相同——做法可能重复。
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISHES } from '../data/dishes.js';
import { RECIPES } from '../data/recipes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const writeIdx = args.indexOf('--write');
const writeTo = writeIdx >= 0 ? args[writeIdx + 1] : null;

const norm = (s) => String(s ?? '')
  .replace(/[\s·・（）()【】[\]、，,。.！!？?：:；;'"“”]/g, '')
  .toLowerCase();

const dishById = new Map(DISHES.map((d) => [d.id, d]));
const recipeById = new Map(RECIPES.map((r) => [r.id, r]));
const where = (d) => d.province ?? d.country ?? '—';
const nutrition = (d) => `${d.nutrition?.kcal ?? '?'} kcal / ${d.nutrition?.protein ?? '?'}g 蛋白`;
const recipeOf = (d) => recipeById.get(d.recipeId) ?? null;

const nameGroups = new Map();
for (const d of DISHES) {
  const key = norm(d.name);
  if (!nameGroups.has(key)) nameGroups.set(key, []);
  nameGroups.get(key).push(d);
}
const exactGroups = [...nameGroups.entries()]
  .filter(([, list]) => list.length > 1)
  .map(([key, list]) => {
    const provinces = new Set(list.map(where));
    return {
      key,
      name: list[0].name,
      list,
      sameRegion: provinces.size === 1,
      provinces: [...provinces],
    };
  });

function levenshtein(a, b) {
  a = [...a]; b = [...b];
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

const normalized = DISHES.map((d) => ({ dish: d, n: norm(d.name) }));
const nearPairs = [];
for (let i = 0; i < normalized.length; i++) {
  for (let j = i + 1; j < normalized.length; j++) {
    const a = normalized[i], b = normalized[j];
    if (a.n === b.n || a.n.length < 3 || b.n.length < 3) continue;
    if (a.n.includes(b.n) || b.n.includes(a.n)) {
      nearPairs.push({ score: 0.95, kind: '包含', a: a.dish, b: b.dish });
      continue;
    }
    const dist = levenshtein(a.n, b.n);
    const score = 1 - dist / Math.max(a.n.length, b.n.length);
    if (score >= 0.8) nearPairs.push({ score, kind: '相似', a: a.dish, b: b.dish });
  }
}
nearPairs.sort((x, y) => y.score - x.score);

const ingredientGroups = new Map();
for (const r of RECIPES) {
  const key = r.ingredients.map((i) => norm(i.name)).sort().join('|');
  if (!ingredientGroups.has(key)) ingredientGroups.set(key, []);
  ingredientGroups.get(key).push(r);
}
const sameIngredientGroups = [...ingredientGroups.values()].filter((l) => l.length > 1);

const exactSameRegion = exactGroups.filter((g) => g.sameRegion);
const exactCrossRegion = exactGroups.filter((g) => !g.sameRegion);

const summary = [
  `菜品 ${DISHES.length} 道 / 菜谱 ${RECIPES.length} 道`,
  `同名（规范化后完全相同）：${exactGroups.length} 组，共 ${exactGroups.reduce((n, g) => n + g.list.length, 0)} 道`,
  `  其中同地区 ${exactSameRegion.length} 组，跨地区 ${exactCrossRegion.length} 组`,
  `高度相似菜名：${nearPairs.length} 对（包含关系或相似度 >= 0.8）`,
  `食材集合完全相同：${sameIngredientGroups.length} 组`,
];

function groupLine(g) {
  return g.list.map((d) => {
    const r = recipeOf(d);
    return `\`${d.id}\`（${where(d)}，${nutrition(d)}，${r ? `${r.steps.length} 步` : '无菜谱'}）`;
  }).join('、');
}

function buildMarkdown() {
  const out = [];
  out.push('# 菜谱重复检查报告', '');
  out.push(`> 生成时间：${new Date().toISOString()}。本报告只做静态检查，不删除/修改任何菜品；同名不等于完全重复，请结合食材与做法人工复核。`, '');
  out.push('## 摘要', '');
  out.push(...summary.map((s) => `- ${s}`));
  out.push('', '## 同名菜品', '');
  if (!exactGroups.length) out.push('无。');
  for (const g of exactGroups) {
    out.push(`### ${g.name}（${g.provinces.join(' / ')}）${g.sameRegion ? '· 同地区' : '· 跨地区'}`, '');
    out.push(`- ${groupLine(g)}`);
    out.push('');
  }
  out.push('## 高度相似菜名（前 60 对）', '');
  if (!nearPairs.length) out.push('无。');
  for (const p of nearPairs.slice(0, 60)) {
    out.push(`- ${p.score.toFixed(2)} ${p.kind}：${p.a.name}（\`${p.a.id}\`，${where(p.a)}）↔ ${p.b.name}（\`${p.b.id}\`，${where(p.b)}）`);
  }
  out.push('', '## 食材集合完全相同的菜谱', '');
  if (!sameIngredientGroups.length) out.push('无。');
  for (const list of sameIngredientGroups) {
    out.push(`- ${list.map((r) => `${r.name}（\`${r.id}\`）`).join('、')}`);
  }
  out.push('', '## 处理建议', '');
  out.push('- **同地区同名**：大概率是并行批次生成的真重复。保留一道、删除另一道，并同步删除对应菜谱；如果需要维持总数，再用新的原创菜补位。');
  out.push('- **跨地区同名**：可能是不同做法（如甘肃/陕西浆水面、云南/西藏青稞饼、四川/重庆酸辣粉）。可保留两道，但建议在菜名中加上地区前缀，避免搜索和菜谱库看起来重复。');
  out.push('- **相似但不同名**：先看食材与步骤；地区变体可保留，完全同做法的再合并。');
  out.push('- **食材集合相同**：不一定重复（调味/步骤可能不同），但值得抽查。');
  out.push('');
  return out.join('\n');
}

for (const line of summary) console.log(line);
console.log('\n同名分组：');
for (const g of exactGroups) console.log(`  ${g.name}（${g.provinces.join('/')}）：${groupLine(g)}`);
console.log(`\n高度相似对（前 20）：`);
for (const p of nearPairs.slice(0, 20)) {
  console.log(`  ${p.score.toFixed(2)} ${p.kind} ${p.a.name}(${p.a.id}) ↔ ${p.b.name}(${p.b.id})`);
}

if (writeTo) {
  const target = path.resolve(root, writeTo);
  await writeFile(target, buildMarkdown(), 'utf8');
  console.log(`\n报告已写入 ${target}`);
}

if (strict && exactGroups.length > 0) {
  console.error(`\n严格模式：发现 ${exactGroups.length} 组同名菜品。`);
  process.exit(1);
}
