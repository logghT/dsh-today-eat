/**
 * 「今天吃什么」推荐内核 —— 饭点状态机。
 *
 * 纯 JS（ESM）、零依赖，host 与 client 两端共用。
 *
 * 依据 `settings.mealTimes`（四餐窗口，支持 `night` 跨零点，如 22:00-01:00）、
 * 可选的 `settings.remindMeals`（只提醒哪些餐，省略=窗口里配置的每餐都提醒）与今日用餐记录，计算：
 * - phase：`before`（今天第一餐前）| `in`（窗口内，可提醒）| `after`（两餐之间）| `closed`（今天餐次已结束）
 * - meal / nextMeal / nextAt / shouldNotify
 */
import {
  MEAL_ORDER,
  combineDateTime,
  formatClock,
  parseClock,
  shanghaiParts,
  shiftDateKey,
} from './time.js';

/** 餐次中文标签。 */
export const MEAL_LABELS = Object.freeze({ breakfast: '早餐', lunch: '午餐', dinner: '晚餐', night: '夜宵' });

/** 默认饭点窗口（与 state.json 示例一致，夜宵需显式配置才启用）。 */
export const DEFAULT_MEAL_TIMES = Object.freeze({
  breakfast: Object.freeze(['07:00', '09:00']),
  lunch: Object.freeze(['11:30', '13:00']),
  dinner: Object.freeze(['17:30', '19:30']),
});

/**
 * 解析今日已记录的餐次集合。
 *
 * @param {Array<{date?: string, meal?: string}>} meals 用餐记录
 * @param {string} today 今天日期键
 * @returns {Set<string>} 今日已记录的餐次
 */
function loggedMealsSet(meals, today) {
  const logged = new Set();
  if (!Array.isArray(meals)) return logged;
  for (const meal of meals) {
    if (!meal || typeof meal !== 'object') continue;
    if (meal.date !== today) continue;
    if (typeof meal.meal === 'string') logged.add(meal.meal);
  }
  return logged;
}

/**
 * 归一化四餐窗口配置，返回按开始时间排序的窗口数组。
 *
 * @param {object | null | undefined} settings 设置
 * @returns {Array<{meal: string, start: number, end: number, cross: boolean}>} 窗口（分钟口径）
 */
function resolveWindows(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const mealTimes = source.mealTimes && typeof source.mealTimes === 'object' ? source.mealTimes : DEFAULT_MEAL_TIMES;
  const remind = Array.isArray(source.remindMeals) && source.remindMeals.length > 0
    ? new Set(source.remindMeals.filter((meal) => MEAL_ORDER.includes(meal)))
    : null;
  const windows = [];
  for (const meal of MEAL_ORDER) {
    if (remind && !remind.has(meal)) continue;
    const range = mealTimes[meal];
    if (!Array.isArray(range) || range.length < 2) continue;
    const start = parseClock(range[0]);
    const end = parseClock(range[1]);
    if (start === null || end === null || start === end) continue;
    windows.push({ meal, start, end, cross: end < start });
  }
  return windows.sort((left, right) => (left.start !== right.start ? left.start - right.start : MEAL_ORDER.indexOf(left.meal) - MEAL_ORDER.indexOf(right.meal)));
}

/**
 * 判断某时刻是否落在窗口内。
 *
 * @param {{start: number, end: number, cross: boolean}} window 窗口
 * @param {number} minutes 当天分钟数
 * @returns {boolean} 是否在窗口内（左闭右开）
 */
function isInside(window, minutes) {
  return window.cross
    ? minutes >= window.start || minutes < window.end
    : minutes >= window.start && minutes < window.end;
}

/**
 * 找「下一个开饭时刻」：返回最早一个开始时间晚于当前时刻的窗口（今天或明天）。
 *
 * @param {Array<{meal: string, start: number}>} windows 窗口
 * @param {string} today 今天日期键
 * @param {number} minutes 当天分钟数
 * @returns {{meal: string, dateKey: string, minutes: number} | null} 下一次开饭
 */
function nextWindowAfter(windows, today, minutes) {
  if (windows.length === 0) return null;
  let best = null;
  for (const window of windows) {
    const candidate = window.start > minutes
      ? { meal: window.meal, dateKey: today, minutes: window.start }
      : { meal: window.meal, dateKey: shiftDateKey(today, 1), minutes: window.start };
    if (best === null) {
      best = candidate;
      continue;
    }
    if (candidate.dateKey < best.dateKey || (candidate.dateKey === best.dateKey && candidate.minutes < best.minutes)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * 构造 nextAt 输出（带 +08:00 的 ISO 字符串 + 毫秒时间戳）。
 *
 * @param {{dateKey: string, minutes: number} | null} next 下一次开饭
 * @returns {{ nextAt: string | null, nextAtMs: number | null }} 时刻
 */
function nextMoment(next) {
  if (!next) return { nextAt: null, nextAtMs: null };
  const combined = combineDateTime(next.dateKey, next.minutes);
  return combined === null ? { nextAt: null, nextAtMs: null } : { nextAt: combined.iso, nextAtMs: combined.ms };
}

/**
 * 计算当前饭点状态。
 *
 * @param {Date | number | string} [now=new Date()] 当前时刻
 * @param {object} [settings] 设置（mealTimes / plannedMeals / notify）
 * @param {Array<{date?: string, meal?: string}>} [meals] 用餐记录（用于判断该餐是否已记录）
 * @returns {{ meal: string | null, phase: 'before'|'in'|'after'|'closed', nextMeal: string | null, nextAt: string | null, nextAtMs: number | null, shouldNotify: boolean, logged: boolean }} 饭点状态
 */
export function mealTimeState(now = new Date(), settings = {}, meals = []) {
  const parts = shanghaiParts(now === undefined ? new Date() : now);
  const source = settings && typeof settings === 'object' ? settings : {};
  const windows = resolveWindows(source);
  const logged = loggedMealsSet(meals, parts.dateKey);
  const notify = source.notify && typeof source.notify === 'object' ? source.notify : null;
  const notifyEnabled = notify ? notify.inApp !== false : true;

  if (windows.length === 0) {
    return {
      meal: null,
      phase: 'closed',
      nextMeal: null,
      nextAt: null,
      nextAtMs: null,
      shouldNotify: false,
      logged: false,
    };
  }

  const inside = windows.find((window) => isInside(window, parts.minutes));
  const next = nextWindowAfter(windows, parts.dateKey, parts.minutes);
  const moment = nextMoment(next);

  if (inside) {
    const mealLogged = logged.has(inside.meal);
    return {
      meal: inside.meal,
      phase: 'in',
      nextMeal: next ? next.meal : null,
      nextAt: moment.nextAt,
      nextAtMs: moment.nextAtMs,
      shouldNotify: notifyEnabled && !mealLogged,
      logged: mealLogged,
      window: {
        start: formatClock(inside.start),
        end: formatClock(inside.end),
        cross: inside.cross,
      },
    };
  }

  // 不在窗口内：用「今天第一餐开始时间」区分 before / after / closed
  const firstStart = Math.min(...windows.map((window) => window.start));
  const nextIsToday = next !== null && next.dateKey === parts.dateKey;
  const phase = nextIsToday
    ? parts.minutes < firstStart ? 'before' : 'after'
    : 'closed';

  return {
    meal: next ? next.meal : null,
    phase,
    nextMeal: next ? next.meal : null,
    nextAt: moment.nextAt,
    nextAtMs: moment.nextAtMs,
    shouldNotify: false,
    logged: nextIsToday ? logged.has(next.meal) : false,
  };
}
