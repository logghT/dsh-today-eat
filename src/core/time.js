/**
 * 「今天吃什么」推荐内核 —— 共享日期 / 时间工具。
 *
 * 纯 JS（ESM）、零依赖，host 与 client 两端共用；不依赖 DOM / Node 专有 API。
 * 所有日期口径统一为「上海时区（UTC+8，中国无夏令时）」，日期键为 `YYYY-MM-DD`，
 * 时刻用「当天 0 点起的分钟数（0-1439）」表示，跨零点由调用方显式处理。
 */

/** 一天毫秒数。 */
export const DAY_IN_MS = 24 * 60 * 60 * 1000;

/** 上海时区固定偏移（中国无夏令时）。 */
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 一天分钟数。 */
export const MINUTES_PER_DAY = 24 * 60;

/** 星期中文标签，索引与 Date#getDay 一致。 */
export const WEEKDAY_LABELS = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);

/** 餐次顺序（早餐 / 午餐 / 晚餐 / 夜宵）。 */
export const MEAL_ORDER = Object.freeze(['breakfast', 'lunch', 'dinner', 'night']);

/**
 * 格式化日期键。
 *
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {number} day 日
 * @returns {string} YYYY-MM-DD
 */
export function formatDateKey(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 把日期输入统一成上海时区的 YYYY-MM-DD 字符串。
 *
 * 支持三种输入：Date（按绝对时刻换算到 UTC+8）、时间戳数字、
 * 字符串（`YYYY-MM-DD` 直接视为上海日期；其它字符串按 ISO 解析）。
 *
 * @param {Date | number | string} value 日期输入
 * @returns {string} 形如 2026-11-08 的日期键
 * @throws {TypeError} 输入无法解析为日期时抛出
 */
export function toDateKey(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('date 不是合法日期');
    const shanghai = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
    return formatDateKey(shanghai.getUTCFullYear(), shanghai.getUTCMonth() + 1, shanghai.getUTCDate());
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('date 不是合法时间戳');
    return toDateKey(new Date(value));
  }
  if (typeof value === 'string') {
    const text = value.trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (dateOnly) {
      const key = `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
      if (dayIndex(key) === null) throw new TypeError(`date 不是合法日期：${value}`);
      return key;
    }
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return toDateKey(parsed);
    throw new TypeError(`无法解析 date：${value}`);
  }
  throw new TypeError('date 需为 Date、时间戳或 YYYY-MM-DD 字符串');
}

/**
 * 尝试把日期输入转成日期键，失败时返回 null（用于过滤脏数据）。
 *
 * @param {unknown} value 日期输入
 * @returns {string | null} 日期键或 null
 */
export function tryToDateKey(value) {
  try {
    return toDateKey(value);
  } catch {
    return null;
  }
}

/**
 * 把日期键换算成 Unix 天序号；非法日期返回 null。
 *
 * @param {string} dateKey YYYY-MM-DD
 * @returns {number | null} 天序号
 */
export function dayIndex(dateKey) {
  if (typeof dateKey !== 'string') return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const time = Date.UTC(year, month - 1, day);
  if (Number.isNaN(time)) return null;
  const check = new Date(time);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(time / DAY_IN_MS);
}

/**
 * 由日期键取星期索引（周日为 0）；非法日期回退为 0。
 *
 * @param {string} dateKey YYYY-MM-DD
 * @returns {number} 0-6
 */
export function weekdayOf(dateKey) {
  const index = dayIndex(dateKey);
  if (index === null) return 0;
  return new Date(index * DAY_IN_MS).getUTCDay();
}

/**
 * 日期键加减天数（返回新的 YYYY-MM-DD；非法输入原样返回）。
 *
 * @param {string} dateKey YYYY-MM-DD
 * @param {number} delta 增加的天数（可为负）
 * @returns {string} 新日期键
 */
export function shiftDateKey(dateKey, delta) {
  const index = dayIndex(dateKey);
  if (index === null) return dateKey;
  const shifted = new Date((index + Math.trunc(Number(delta) || 0)) * DAY_IN_MS);
  return formatDateKey(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/**
 * 取上海时区「今天」的日期键。
 *
 * @param {Date | number | string} [value=new Date()] 参照时刻
 * @returns {string} YYYY-MM-DD
 */
export function todayKey(value = new Date()) {
  return toDateKey(value);
}

/**
 * 把任意时刻解析为上海时区的 {日期键, 当天分钟数, 星期}。
 *
 * @param {Date | number | string} [value=new Date()] 时刻输入
 * @returns {{ dateKey: string, minutes: number, weekday: number }} 上海时间分量
 */
export function shanghaiParts(value = new Date()) {
  let date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'number') date = new Date(value);
  else if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      // 只有日期时按当天 12:00 估算（与 inferMeal 口径一致）
      return { dateKey: text, minutes: 12 * 60, weekday: weekdayOf(text) };
    }
    date = new Date(text);
  } else {
    date = new Date();
  }
  if (Number.isNaN(date.getTime())) date = new Date();
  const shanghai = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const dateKey = formatDateKey(shanghai.getUTCFullYear(), shanghai.getUTCMonth() + 1, shanghai.getUTCDate());
  const minutes = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
  return { dateKey, minutes, weekday: shanghai.getUTCDay() };
}

/**
 * 解析 `HH:MM` 时钟文本为当天分钟数。
 *
 * @param {unknown} text 时钟文本（也接受 0-1439 的数字）
 * @returns {number | null} 0-1439，非法返回 null
 */
export function parseClock(text) {
  if (typeof text === 'number') {
    if (!Number.isFinite(text)) return null;
    const minutes = Math.trunc(text);
    return minutes >= 0 && minutes < MINUTES_PER_DAY ? minutes : null;
  }
  if (typeof text !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * 把当天分钟数格式化为 `HH:MM`（自动按 24 小时取模）。
 *
 * @param {number} minutes 当天分钟数
 * @returns {string} HH:MM
 */
export function formatClock(minutes) {
  const value = ((Math.trunc(Number(minutes) || 0) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/**
 * 把「上海日期键 + 当天分钟数」组合成绝对时刻。
 *
 * @param {string} dateKey YYYY-MM-DD
 * @param {number} minutes 当天分钟数
 * @returns {{ iso: string, ms: number } | null} 带 +08:00 的 ISO 字符串与时间戳
 */
export function combineDateTime(dateKey, minutes) {
  const index = dayIndex(dateKey);
  const clock = Number(minutes);
  if (index === null || !Number.isFinite(clock)) return null;
  const normalized = ((Math.trunc(clock) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const ms = index * DAY_IN_MS + normalized * 60 * 1000 - SHANGHAI_OFFSET_MS;
  return {
    iso: `${dateKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`,
    ms,
  };
}
