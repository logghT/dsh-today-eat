/**
 * 「今天吃什么」推荐内核 —— 确定性随机工具。
 *
 * 零依赖、纯函数，可在插件 host 半与 client 半共用；不依赖 DOM / Node 专有 API。
 * 所有随机都来自显式种子，因此相同输入在不同端、不同时间都会得到相同序列。
 */

/**
 * 把任意输入散列成 32 位无符号整数（FNV-1a + 位混淆，结果跨环境稳定）。
 *
 * 用于把「日期 + 餐次 + 偏好」压缩成一个确定性的随机种子，
 * 保证同一组推荐条件永远得到同一份菜单。
 *
 * @param {unknown} input 任意输入，内部统一转成字符串再散列
 * @returns {number} 0 ~ 2^32-1 的整数
 */
export function hashString(input) {
  const text = String(input);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * 稳定序列化：对象按键名排序、丢弃 undefined，保证等价输入得到同一字符串。
 *
 * 推荐种子依赖它，因此 `{ a: 1, b: 2 }` 与 `{ b: 2, a: 1 }` 会得到同一个种子。
 *
 * @param {unknown} value 待序列化的值（普通对象 / 数组 / 原始值）
 * @returns {string} 稳定字符串
 */
export function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (type === 'object') {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  // bigint / symbol / function 等不可序列化值统一视为 null
  return 'null';
}

/**
 * 创建 mulberry32 确定性伪随机数生成器。
 *
 * 同一个种子永远得到同一串 [0, 1) 浮点数；不依赖 Math.random，可安全用于
 * 每日菜单、换一道等需要「可回放」的场景。
 *
 * @param {number} [seed=0x9e3779b9] 32 位整数种子（通常来自 {@link hashString}）
 * @returns {() => number} 每次调用返回 [0, 1) 的伪随机数
 */
export function createRng(seed = 0x9e3779b9) {
  const numericSeed = Number(seed);
  let state = Number.isFinite(numericSeed) ? numericSeed >>> 0 : 0x9e3779b9;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * 按权重从条目中抽取一项（单次加权随机）。
 *
 * @param {Array} items 候选条目数组
 * @param {((item: any, index: number) => number) | number[]} [weightOf] 权重函数或与 items 对齐的权重数组；缺省等权
 * @param {() => number} [rng] 随机数生成器（返回 [0,1)），缺省 Math.random
 * @returns {any | undefined} 被抽中的条目；空数组返回 undefined
 */
export function pickWeighted(items, weightOf, rng) {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const weightFor = typeof weightOf === 'function'
    ? weightOf
    : Array.isArray(weightOf)
      ? (item, index) => weightOf[index]
      : () => 1;
  const random = typeof rng === 'function' ? rng : Math.random;
  const weights = items.map((item, index) => {
    const weight = Number(weightFor(item, index));
    return Number.isFinite(weight) && weight > 0 ? weight : 0;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    // 权重全部非法或为 0 时退化为等概率，但仍消耗同一个 RNG 序列
    return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
  }
  let threshold = random() * total;
  for (let index = 0; index < items.length; index += 1) {
    threshold -= weights[index];
    if (threshold < 0) return items[index];
  }
  // 浮点误差兜底
  return items[items.length - 1];
}
