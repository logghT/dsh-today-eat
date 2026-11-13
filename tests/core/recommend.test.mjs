/**
 * 「今天吃什么」推荐内核单元测试。
 *
 * 运行（本机没有全局 node，用 DSH 内置运行时）：
 *   $node='<USER_HOME>\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe'
 *   & $node --test tests/core/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DISHES } from '../../data/dishes.js';
import { createRng, hashString, pickWeighted, stableStringify } from '../../src/core/rng.js';
import {
  CATEGORIES,
  CUISINES,
  MEALS,
  SPICY_LEVELS,
  getDailyPick,
  inferMeal,
  normalizePreferences,
  pruneHistory,
  recordPick,
  reroll,
} from '../../src/core/recommend.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SPICY_RANK = { mild: 1, medium: 2, hot: 3 };
const ALLOWED_TAGS = new Set([...SPICY_LEVELS, 'meat', 'veg', 'seafood', 'soup', 'noodle', 'rice', 'light']);
const REQUIRED_KEYS = ['id', 'name', 'emoji', 'category', 'cuisine', 'tags', 'price', 'description'];

/** 生成指定上海小时对应的 Date（内部按 UTC+8 换算，负数小时由 Date.UTC 自动归一）。 */
function shanghaiTime(hour, minute = 0) {
  return new Date(Date.UTC(2026, 0, 5, hour - 8, minute, 0));
}

/** 生成从 2026-11-01 起的连续日期字符串数组。 */
function dateKeys(count) {
  return Array.from({ length: count }, (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}`);
}

/** 取某道菜的辣度标签。 */
function spicyOf(dish) {
  return dish.tags.find((tag) => SPICY_LEVELS.includes(tag));
}

/** 断言素食偏好下的菜不含 meat / seafood。 */
function assertVegetarian(dish, label) {
  assert.ok(!dish.tags.includes('meat'), `${label}：${dish.id} 含 meat，不应出现在素食结果里`);
  assert.ok(!dish.tags.includes('seafood'), `${label}：${dish.id} 含 seafood，不应出现在素食结果里`);
}

/** 断言结果对象的结构完整。 */
function assertPickShape(result, label) {
  assert.ok(result && typeof result === 'object', `${label}：结果应为对象`);
  assert.ok(Array.isArray(result.alternatives), `${label}：alternatives 应为数组`);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0, `${label}：reason 应为非空字符串`);
  assert.match(result.date, /^\d{4}-\d{2}-\d{2}$/, `${label}：date 应为 YYYY-MM-DD`);
  assert.ok(MEALS.includes(result.meal), `${label}：meal 应为合法餐次`);
  assert.ok('fallbackNote' in result, `${label}：应包含 fallbackNote 字段`);
}

test('rng：hashString 稳定、返回无符号整数且能区分输入', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
  const value = hashString('2026-11-08|lunch|{}');
  assert.ok(Number.isInteger(value));
  assert.ok(value >= 0 && value <= 0xffffffff);
  assert.equal(hashString(''), hashString(''));
});

test('rng：createRng 同种子同序列，输出落在 [0,1)', () => {
  const first = createRng(12345);
  const second = createRng(12345);
  for (let index = 0; index < 20; index += 1) {
    const value = first();
    assert.equal(value, second());
    assert.ok(value >= 0 && value < 1);
  }
});

test('rng：pickWeighted 按权重抽取，空数组与零权重有兜底', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(pickWeighted([], () => 1, createRng(1)), undefined);
  assert.equal(pickWeighted(items, (item) => (item.id === 'a' ? 5 : 0), createRng(1)).id, 'a');
  const fallback = pickWeighted(items, [0, 0, 0], createRng(7));
  assert.ok(items.includes(fallback), '零权重时应退化为等概率抽取');
});

test('rng：stableStringify 与键顺序无关、与数组顺序有关', () => {
  assert.equal(stableStringify({ a: 1, b: [2, 3] }), stableStringify({ b: [2, 3], a: 1 }));
  assert.notEqual(stableStringify({ a: [1, 2] }), stableStringify({ a: [2, 1] }));
  assert.equal(stableStringify({ a: undefined, b: 1 }), stableStringify({ b: 1 }));
});

test('inferMeal：按上海小时返回四档餐次', () => {
  const cases = [
    [0, 'night'], [4, 'night'], [5, 'breakfast'], [9, 'breakfast'],
    [10, 'lunch'], [14, 'lunch'], [15, 'dinner'], [20, 'dinner'],
    [21, 'night'], [23, 'night'],
  ];
  for (const [hour, expected] of cases) {
    assert.equal(inferMeal(shanghaiTime(hour)), expected, `${hour} 点应推断为 ${expected}`);
  }
  // 只有日期字符串时按当天中午估算，属于午餐时段
  assert.equal(inferMeal('2026-11-08'), 'lunch');
});

test('normalizePreferences：默认值与非法输入归一化', () => {
  assert.deepEqual(normalizePreferences(), {
    vegetarian: false,
    maxSpicy: 'hot',
    maxPrice: null,
    categories: [],
    cuisines: [],
    avoidTags: [],
  });
  const normalized = normalizePreferences({
    vegetarian: 'yes',
    maxSpicy: 'super-hot',
    maxPrice: 'abc',
    categories: ['面食', '面食', '不存在的分类', '米饭'],
    cuisines: ['粤菜', '火星菜'],
    avoidTags: ['Seafood', 'seafood', ' '],
  });
  assert.equal(normalized.vegetarian, false, 'vegetarian 仅严格 true 生效');
  assert.equal(normalized.maxSpicy, 'hot', '非法辣度回退为 hot（不限）');
  assert.equal(normalized.maxPrice, null, '非法价格回退为 null（不限）');
  assert.deepEqual(normalized.categories, ['米饭', '面食'], '分类去重并排序，忽略未知值');
  assert.deepEqual(normalized.cuisines, ['粤菜'], '菜系忽略未知值');
  assert.deepEqual(normalized.avoidTags, ['seafood'], '避雷 tags 小写去重');

  assert.deepEqual(normalizePreferences({ vegetarian: true, maxSpicy: 'mild', maxPrice: 16 }), {
    vegetarian: true,
    maxSpicy: 'mild',
    maxPrice: 16,
    categories: [],
    cuisines: [],
    avoidTags: [],
  });
});

test('菜系枚举：云南菜合法且偏好过滤 / 推荐不会丢弃', () => {
  assert.ok(CUISINES.includes('云南菜'), 'CUISINES 应包含「云南菜」');
  assert.ok(CUISINES.length >= 11, `菜系应至少 11 类，当前 ${CUISINES.length}`);
  // normalizePreferences 只过滤未知菜系，不再把「云南菜」当非法值
  assert.deepEqual(normalizePreferences({ cuisines: ['云南菜', '火星菜'] }).cuisines, ['云南菜']);

  // 内联 fixture：云南菜菜品在 cuisines 偏好下仍能被推荐（不依赖 data 迁移时序）
  const catalog = [
    {
      id: 'yn-dai-fish',
      name: '傣味烤鱼',
      emoji: '🐟',
      category: '家常菜',
      cuisine: '云南菜',
      tags: ['medium', 'meat'],
      price: 34,
      description: '香茅柠檬腌制的烤鱼，酸辣开胃还带炭火香',
    },
  ];
  const result = getDailyPick({
    date: '2026-11-13',
    meal: 'lunch',
    catalog,
    preferences: { cuisines: ['云南菜'] },
  });
  assert.ok(result.dish, '云南菜偏好下应有推荐结果');
  assert.equal(result.dish.id, 'yn-dai-fish');
  assert.equal(result.dish.cuisine, '云南菜');
});

test('getDailyPick：同一 (date, meal, preferences) 结果确定', () => {
  const options = { date: '2026-11-08', meal: 'lunch', preferences: { categories: ['面食'] } };
  const first = getDailyPick(options);
  const second = getDailyPick(options);
  assert.deepEqual(first, second);
  assertPickShape(first, '确定性');
  assert.equal(first.alternatives.length, 3, '完整菜品库下应返回 3 道备选');
  assert.equal(new Set([first.dish.id, ...first.alternatives.map((dish) => dish.id)]).size, 4, '主菜与备选不应重复');

  // 偏好数组顺序不影响结果（归一化后排序 + 稳定序列化）
  const a = getDailyPick({
    date: '2026-11-09',
    meal: 'dinner',
    preferences: { categories: ['面食', '汤羹'], avoidTags: ['hot', 'seafood'] },
  });
  const b = getDailyPick({
    date: '2026-11-09',
    meal: 'dinner',
    preferences: { avoidTags: ['seafood', 'hot'], categories: ['汤羹', '面食'] },
  });
  assert.deepEqual(a, b);
});

test('getDailyPick：Date 输入按上海时区归一化日期并推断餐次', () => {
  // 上海 2026-11-09 01:30，属于夜宵时段
  const lateNight = new Date('2026-11-08T17:30:00Z');
  const result = getDailyPick({ date: lateNight, meal: 'night' });
  assert.equal(result.date, '2026-11-09');
  assert.equal(result.meal, 'night');
  assert.deepEqual(result, getDailyPick({ date: lateNight, meal: 'night' }));
  // 不传 meal 时按注入的时刻推断
  assert.equal(getDailyPick({ date: lateNight }).meal, 'night');
});

test('getDailyPick：结果与 catalog 数组顺序无关', () => {
  const catalog = DISHES.slice(0, 20);
  const first = getDailyPick({ date: '2026-11-08', meal: 'lunch', catalog });
  const second = getDailyPick({ date: '2026-11-08', meal: 'lunch', catalog: [...catalog].reverse() });
  assert.equal(first.dish.id, second.dish.id);
  assert.deepEqual(first.alternatives.map((dish) => dish.id), second.alternatives.map((dish) => dish.id));
});

test('getDailyPick：不同日期 / 不同餐次会带来差异', () => {
  const ids = new Set(dateKeys(12).map((date) => getDailyPick({ date, meal: 'lunch' }).dish.id));
  assert.ok(ids.size > 1, '12 个不同日期不应总推荐同一道菜');

  const mealIds = new Set(MEALS.map((meal) => getDailyPick({ date: '2026-11-08', meal }).dish.id));
  assert.ok(mealIds.size > 1, '同一天不同餐次不应总推荐同一道菜');
});

test('偏好硬过滤：素食', () => {
  for (const date of dateKeys(20)) {
    const result = getDailyPick({ date, meal: 'lunch', preferences: { vegetarian: true } });
    assertPickShape(result, `素食 ${date}`);
    assert.equal(result.fallbackNote, null, '完整菜品库下不应触发放宽');
    for (const dish of [result.dish, ...result.alternatives]) {
      assertVegetarian(dish, `素食 ${date}`);
    }
  }
});

test('偏好硬过滤：辣度上限', () => {
  for (const date of dateKeys(20)) {
    const result = getDailyPick({ date, meal: 'dinner', preferences: { maxSpicy: 'mild' } });
    for (const dish of [result.dish, ...result.alternatives]) {
      assert.equal(spicyOf(dish), 'mild', `${date}：${dish.id} 辣度超过上限`);
    }
  }
  for (const date of dateKeys(10)) {
    const result = getDailyPick({ date, meal: 'dinner', preferences: { maxSpicy: 'medium' } });
    for (const dish of [result.dish, ...result.alternatives]) {
      assert.ok(SPICY_RANK[spicyOf(dish)] <= SPICY_RANK.medium, `${date}：${dish.id} 辣度超过上限`);
    }
  }
});

test('偏好硬过滤：价格上限', () => {
  for (const date of dateKeys(20)) {
    const result = getDailyPick({ date, meal: 'lunch', preferences: { maxPrice: 16 } });
    assert.equal(result.fallbackNote, null);
    for (const dish of [result.dish, ...result.alternatives]) {
      assert.ok(dish.price <= 16, `${date}：${dish.id} 价格 ${dish.price} 超过上限`);
    }
  }
});

test('偏好硬过滤：分类 / 菜系 / 避雷 tags', () => {
  for (const date of dateKeys(10)) {
    const result = getDailyPick({ date, meal: 'lunch', preferences: { categories: ['汤羹'] } });
    for (const dish of [result.dish, ...result.alternatives]) {
      assert.equal(dish.category, '汤羹', `${date}：${dish.id} 分类不符`);
    }
  }
  for (const date of dateKeys(10)) {
    const result = getDailyPick({ date, meal: 'dinner', preferences: { cuisines: ['粤菜'] } });
    for (const dish of [result.dish, ...result.alternatives]) {
      assert.equal(dish.cuisine, '粤菜', `${date}：${dish.id} 菜系不符`);
    }
  }
  for (const date of dateKeys(10)) {
    const result = getDailyPick({ date, meal: 'lunch', preferences: { avoidTags: ['noodle', 'soup'] } });
    for (const dish of [result.dish, ...result.alternatives]) {
      assert.ok(!dish.tags.includes('noodle') && !dish.tags.includes('soup'), `${date}：${dish.id} 命中避雷 tag`);
    }
  }
});

test('偏好组合：素食 + 微辣 + 价格上限同时生效', () => {
  for (const date of dateKeys(15)) {
    const result = getDailyPick({
      date,
      meal: 'dinner',
      preferences: { vegetarian: true, maxSpicy: 'mild', maxPrice: 30 },
    });
    assertPickShape(result, `组合偏好 ${date}`);
    for (const dish of [result.dish, ...result.alternatives]) {
      assertVegetarian(dish, `组合偏好 ${date}`);
      assert.equal(spicyOf(dish), 'mild');
      assert.ok(dish.price <= 30);
    }
  }
});

test('默认偏好下价格 / 辣度只做软加权（不会只挑极端菜）', () => {
  const results = Array.from({ length: 200 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 1) + index * DAY_MS).toISOString().slice(0, 10);
    return getDailyPick({ date, meal: 'lunch' }).dish;
  });
  const hotCount = results.filter((dish) => spicyOf(dish) === 'hot').length;
  const expensiveCount = results.filter((dish) => dish.price > 60).length;
  assert.ok(hotCount / results.length < 0.35, `重辣占比 ${hotCount}/${results.length} 偏高，软加权可能失效`);
  assert.ok(expensiveCount / results.length < 0.25, `高价菜占比 ${expensiveCount}/${results.length} 偏高，软加权可能失效`);
});

test('reason：中文自然文案包含星期、餐次、辣度、人均与新鲜度', () => {
  const result = getDailyPick({ date: '2026-11-11', meal: 'lunch' });
  assert.match(result.reason, /^周三午餐 · (微辣|中辣|重辣) · 人均 ¥\d+ · 近 7 天没吃过$/);
  const rerolled = reroll({ date: '2026-11-11', meal: 'lunch', previousIds: [result.dish.id] });
  assert.match(rerolled.reason, /换一道/);
  assert.match(rerolled.reason, /^周三午餐 · /);
});

test('history：近 7 天吃过的菜被排除', () => {
  const excluded = DISHES[0].id;
  for (const date of dateKeys(15)) {
    const target = new Date(Date.parse(`${date}T00:00:00Z`) - 3 * DAY_MS).toISOString().slice(0, 10);
    const history = [{ dishId: excluded, date: target, meal: 'lunch' }];
    const result = getDailyPick({ date, meal: 'lunch', history });
    assert.equal(result.fallbackNote, null, '完整菜品库下不应触发放宽');
    assert.notEqual(result.dish.id, excluded, `${date}：不应推荐近 3 天吃过的菜`);
    assert.ok(result.alternatives.every((dish) => dish.id !== excluded), `${date}：备选也不应含近期菜`);
  }
});

test('history：7 天窗口边界与旧记录（不排除）', () => {
  const catalog = DISHES.slice(0, 8); // 8 道菜，正好等于新鲜候选阈值
  const excluded = catalog[0].id;
  // 目标 2026-11-14；6 天前（11-08）在窗口内 → 新鲜候选只剩 7 道，触发放宽
  const inside = getDailyPick({
    date: '2026-11-14',
    meal: 'lunch',
    catalog,
    history: [{ dishId: excluded, date: '2026-11-08', meal: 'lunch' }],
  });
  assert.ok(inside.fallbackNote, '窗口内近期菜应触发放宽说明');
  assert.match(inside.fallbackNote, /放宽/);
  // 7 天前（11-07）已出窗口 → 仍视为新鲜，新鲜候选 8 道，不触发放宽
  const outside = getDailyPick({
    date: '2026-11-14',
    meal: 'lunch',
    catalog,
    history: [{ dishId: excluded, date: '2026-11-07', meal: 'lunch' }],
  });
  assert.equal(outside.fallbackNote, null, '窗口外的历史不应参与排除');
});

test('reroll：不重复 previousIds，也不返回近期吃过的菜', () => {
  const date = '2026-11-14';
  const meal = 'dinner';
  const recentDishId = DISHES[0].id;
  const history = [{ dishId: recentDishId, date: '2026-11-12', meal: 'lunch' }];
  const daily = getDailyPick({ date, meal, history });
  const previousIds = [daily.dish.id];
  for (let index = 0; index < 12; index += 1) {
    const next = reroll({ date, meal, history, previousIds });
    assertPickShape(next, `换一道 #${index}`);
    assert.ok(!previousIds.includes(next.dish.id), `换一道 #${index} 重复了 previousIds`);
    assert.notEqual(next.dish.id, recentDishId, `换一道 #${index} 返回了近期吃过的菜`);
    assert.ok(next.alternatives.every((dish) => !previousIds.includes(dish.id)));
    previousIds.push(next.dish.id);
  }
  assert.equal(new Set(previousIds).size, previousIds.length, 'previousIds 累积后应全部不重复');
});

test('reroll：相同输入结果确定', () => {
  const options = { date: '2026-11-14', meal: 'dinner', previousIds: ['yangzhou-fried-rice'] };
  assert.deepEqual(reroll(options), reroll(options));
});

test('reroll：previousIds 耗尽时回退并说明', () => {
  const catalog = DISHES.slice(0, 2);
  const previousIds = catalog.map((dish) => dish.id);
  const result = reroll({ date: '2026-11-14', meal: 'lunch', catalog, previousIds });
  assert.ok(result.dish, '候选耗尽时应回退到可返回的菜');
  assert.ok(result.fallbackNote, '候选耗尽时应给出 fallbackNote');
  assert.match(result.fallbackNote, /耗尽/);
});

test('偏好无解时返回空结果并说明原因', () => {
  const meatOnly = DISHES.filter((dish) => dish.tags.includes('meat')).slice(0, 3);
  const result = getDailyPick({
    date: '2026-11-11',
    meal: 'lunch',
    catalog: meatOnly,
    preferences: { vegetarian: true },
  });
  assertPickShape(result, '无解偏好');
  assert.equal(result.dish, null);
  assert.deepEqual(result.alternatives, []);
  assert.ok(result.fallbackNote && result.fallbackNote.length > 0);
});

test('recordPick：纯函数追加，不修改原 history', () => {
  const history = [{ dishId: 'yangzhou-fried-rice', date: '2026-11-01', meal: 'lunch' }];
  const pick = getDailyPick({ date: '2026-11-11', meal: 'dinner' });
  const next = recordPick(history, pick);
  assert.equal(history.length, 1, '原 history 不应被修改');
  assert.equal(next.length, 2);
  assert.deepEqual(next[1], { dishId: pick.dish.id, date: '2026-11-11', meal: 'dinner' });
  assert.equal(recordPick(undefined, pick).length, 1);
  assert.throws(() => recordPick(history, {}), TypeError);
});

test('pruneHistory：保留最近 7 个自然日（含今天），其余剔除', () => {
  const today = '2026-11-08';
  const history = [
    { dishId: 'a', date: '2026-11-08', meal: 'lunch' },
    { dishId: 'b', date: '2026-11-07', meal: 'lunch' },
    { dishId: 'c', date: '2026-11-02', meal: 'lunch' },
    { dishId: 'd', date: '2026-11-01', meal: 'lunch' },
    { dishId: 'e', date: '2026-10-01', meal: 'lunch' },
    { dishId: 'f', date: '不是日期', meal: 'lunch' },
    { dishId: 'g', date: '2026-11-20', meal: 'lunch' },
  ];
  const pruned = pruneHistory(history, { days: 7, today });
  assert.deepEqual(pruned.map((entry) => entry.dishId), ['a', 'b', 'c'], '应保留 today 及之前 6 天');
  assert.equal(history.length, 7, '原 history 不应被修改');
  assert.equal(pruned[0], history[0], '应保留原对象引用');
  assert.deepEqual(pruneHistory(history, { days: 1, today }).map((entry) => entry.dishId), ['a']);
  assert.deepEqual(pruneHistory(history, { days: 30, today }).map((entry) => entry.dishId), ['a', 'b', 'c', 'd']);
  assert.deepEqual(pruneHistory([], { days: 7, today }), []);
  // 非法天数回退为默认 7 天
  assert.deepEqual(
    pruneHistory(history, { days: 0, today }).map((entry) => entry.dishId),
    ['a', 'b', 'c'],
  );
});

test('catalog：菜品数量、id 唯一与字段完整性', () => {
  assert.ok(Array.isArray(DISHES));
  assert.ok(DISHES.length >= 70, `菜品数量应 >= 70，当前 ${DISHES.length}`);

  const ids = new Set();
  for (const dish of DISHES) {
    for (const key of REQUIRED_KEYS) {
      assert.ok(dish[key] !== undefined, `${dish.id} 缺少字段 ${key}`);
    }
    assert.match(dish.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${dish.id} 不是稳定 kebab id`);
    assert.ok(!ids.has(dish.id), `重复 id：${dish.id}`);
    ids.add(dish.id);
    assert.ok(typeof dish.name === 'string' && dish.name.length > 0, `${dish.id} name 为空`);
    assert.ok(typeof dish.emoji === 'string' && [...dish.emoji].length > 0, `${dish.id} emoji 为空`);
    assert.ok(CATEGORIES.includes(dish.category), `${dish.id} 分类非法：${dish.category}`);
    assert.ok(CUISINES.includes(dish.cuisine), `${dish.id} 菜系非法：${dish.cuisine}`);
    assert.ok(Array.isArray(dish.tags) && dish.tags.length > 0, `${dish.id} tags 为空`);
    assert.equal(new Set(dish.tags).size, dish.tags.length, `${dish.id} tags 有重复`);
    assert.ok(dish.tags.every((tag) => ALLOWED_TAGS.has(tag)), `${dish.id} 含未知 tag`);
    assert.ok(SPICY_LEVELS.includes(spicyOf(dish)), `${dish.id} 缺少合法辣度`);
    assert.ok(dish.tags.some((tag) => ['meat', 'veg', 'seafood'].includes(tag)), `${dish.id} 缺少荤素标记`);
    assert.ok(Number.isFinite(dish.price) && dish.price >= 10 && dish.price <= 80, `${dish.id} 价格 ${dish.price} 不在 10-80`);
    assert.ok(typeof dish.description === 'string', `${dish.id} description 不是字符串`);
    const length = [...dish.description].length;
    assert.ok(length >= 20 && length <= 40, `${dish.id} description 长度 ${length} 不在 20-40`);
    assert.match(dish.description, /[\u4e00-\u9fa5]/, `${dish.id} description 应为中文`);
    // 分类与 tags 的一致性：面食含 noodle、米饭含 rice、汤羹含 soup、轻食含 light
    if (dish.category === '面食') assert.ok(dish.tags.includes('noodle'), `${dish.id} 面食缺少 noodle`);
    if (dish.category === '米饭') assert.ok(dish.tags.includes('rice'), `${dish.id} 米饭缺少 rice`);
    if (dish.category === '汤羹') assert.ok(dish.tags.includes('soup'), `${dish.id} 汤羹缺少 soup`);
    if (dish.category === '轻食') assert.ok(dish.tags.includes('light'), `${dish.id} 轻食缺少 light`);
  }
});

test('catalog：分类 / 菜系 / 辣度 / 价格带覆盖足够分散', () => {
  const categoryCount = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  const cuisineCount = Object.fromEntries(CUISINES.map((cuisine) => [cuisine, 0]));
  const spicyCount = Object.fromEntries(SPICY_LEVELS.map((level) => [level, 0]));
  const priceBands = { cheap: 0, normal: 0, pricey: 0, luxury: 0 };
  let lightCount = 0;
  for (const dish of DISHES) {
    categoryCount[dish.category] += 1;
    cuisineCount[dish.cuisine] += 1;
    spicyCount[spicyOf(dish)] += 1;
    if (dish.tags.includes('light')) lightCount += 1;
    if (dish.price <= 15) priceBands.cheap += 1;
    else if (dish.price <= 30) priceBands.normal += 1;
    else if (dish.price <= 50) priceBands.pricey += 1;
    else priceBands.luxury += 1;
  }
  for (const [category, count] of Object.entries(categoryCount)) {
    assert.ok(count >= 5, `分类 ${category} 只有 ${count} 道，覆盖不足`);
  }
  for (const [cuisine, count] of Object.entries(cuisineCount)) {
    // 数据侧「云南菜」独立列出的迁移与 core 枚举改动可能并行完成；
    // 已有该菜系菜品时要求覆盖 >= 3，暂未迁移时跳过（不写死菜系数量）。
    if (count === 0) continue;
    assert.ok(count >= 3, `菜系 ${cuisine} 只有 ${count} 道，覆盖不足`);
  }
  for (const [level, count] of Object.entries(spicyCount)) {
    assert.ok(count > 0, `辣度 ${level} 没有菜品`);
  }
  assert.ok(lightCount >= 8, `清淡（light）菜品只有 ${lightCount} 道`);
  for (const [band, count] of Object.entries(priceBands)) {
    assert.ok(count > 0, `价格带 ${band} 没有菜品`);
  }
});
