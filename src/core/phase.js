/**
 * 「今天吃什么」推荐内核 —— 饮食阶段（phase）与营养目标。
 *
 * 纯 JS（ESM）、零依赖，host 与 client 两端共用。
 *
 * 阶段按「目标 + 吃饭场景」拆开，默认九选一：
 * - performance 训练补给（旧 fitness）
 * - low_sugar 少糖日常
 * - low_sodium 清淡少盐（旧 healthy）
 * - gentle 养胃
 * - high_fiber 高纤维多吃菜
 * - plant_based 多吃素
 * - special 特殊时期（孕期备孕 / 银发 / 青少年）
 * - recovery 养身体（病后 / 术后）
 * - treat 吃的高兴（旧 relax / indulgence）
 *
 * 每个阶段带子目标；旧四阶段会迁移到新阶段，历史记录与周计划不丢。
 * 1000 道菜的 `phases` 仍是旧四维（fitness/healthy/relax/indulgence），
 * 新阶段的适配分由 `phase-rules.js` 按营养、食材、标签动态计算。
 */
import { toDateKey, todayKey } from './time.js';

/** 阶段枚举（canonical）。 */
export const PHASES = Object.freeze([
  'performance',
  'low_sugar',
  'low_sodium',
  'gentle',
  'high_fiber',
  'plant_based',
  'special',
  'recovery',
  'treat',
]);

/** 各阶段子目标枚举（canonical）。 */
export const PHASE_SUBGOALS = Object.freeze({
  performance: Object.freeze(['fat_loss', 'muscle_gain', 'maintain', 'weight_gain']),
  low_sugar: Object.freeze(['steady', 'low_gi']),
  low_sodium: Object.freeze(['low_salt', 'heart']),
  gentle: Object.freeze(['gentle', 'easy_digest']),
  high_fiber: Object.freeze(['fiber', 'gut']),
  plant_based: Object.freeze(['lacto_ovo', 'vegan', 'flexitarian']),
  special: Object.freeze(['prenatal', 'senior', 'teen']),
  recovery: Object.freeze(['post_illness', 'post_surgery']),
  treat: Object.freeze(['treat', 'celebrate']),
});

/** 全部子目标（扁平，保序去重）。 */
export const SUBGOALS = Object.freeze(
  [...new Set(Object.values(PHASE_SUBGOALS).flat())],
);

/** 旧「健身子目标」导出，兼容旧调用。 */
export const FITNESS_SUBGOALS = PHASE_SUBGOALS.performance;

/** 阶段元信息（label / desc / emoji），client 与 host 共用。 */
export const PHASE_META = Object.freeze({
  performance: Object.freeze({ label: '训练补给', desc: '训练前后补给，蛋白优先', emoji: '🏋️' }),
  low_sugar: Object.freeze({ label: '少糖日常', desc: '少糖稳一点，选低 GI', emoji: '🍵' }),
  low_sodium: Object.freeze({ label: '清淡少盐', desc: '少盐少油，蔬菜多一点', emoji: '🥬' }),
  gentle: Object.freeze({ label: '养胃', desc: '温和好消化，别刺激', emoji: '🍲' }),
  high_fiber: Object.freeze({ label: '高纤维多吃菜', desc: '蔬菜全谷，肠道舒服', emoji: '🥦' }),
  plant_based: Object.freeze({ label: '多吃素', desc: '植物为主，豆类坚果', emoji: '🌱' }),
  special: Object.freeze({ label: '特殊时期', desc: '孕期 / 银发 / 青少年，按需吃', emoji: '👪' }),
  recovery: Object.freeze({ label: '养身体', desc: '病后术后，温和补蛋白', emoji: '🧡' }),
  treat: Object.freeze({ label: '吃的高兴', desc: '想吃什么吃什么，开心第一', emoji: '🍻' }),
});

/** 子目标元信息。 */
export const SUBGOAL_META = Object.freeze({
  fat_loss: Object.freeze({ label: '减脂' }),
  muscle_gain: Object.freeze({ label: '增肌' }),
  maintain: Object.freeze({ label: '维持' }),
  weight_gain: Object.freeze({ label: '增重' }),
  steady: Object.freeze({ label: '稳糖' }),
  low_gi: Object.freeze({ label: '低 GI' }),
  low_salt: Object.freeze({ label: '低盐' }),
  heart: Object.freeze({ label: '护心' }),
  gentle: Object.freeze({ label: '清淡养胃' }),
  easy_digest: Object.freeze({ label: '易消化' }),
  fiber: Object.freeze({ label: '高纤' }),
  gut: Object.freeze({ label: '肠道友好' }),
  lacto_ovo: Object.freeze({ label: '蛋奶素' }),
  vegan: Object.freeze({ label: '纯素' }),
  flexitarian: Object.freeze({ label: '弹性素' }),
  prenatal: Object.freeze({ label: '孕期备孕' }),
  senior: Object.freeze({ label: '银发' }),
  teen: Object.freeze({ label: '青少年' }),
  post_illness: Object.freeze({ label: '病后' }),
  post_surgery: Object.freeze({ label: '术后' }),
  treat: Object.freeze({ label: '日常犒劳' }),
  celebrate: Object.freeze({ label: '聚餐庆祝' }),
});

/** 旧阶段名 → 新阶段名。 */
export const LEGACY_PHASE_ALIASES = Object.freeze({
  fitness: 'performance',
  healthy: 'low_sodium',
  relax: 'treat',
  indulgence: 'treat',
});

/** 默认体重（kg），用于把蛋白目标换算成克数。 */
export const DEFAULT_WEIGHT_KG = 75;

/** 默认阶段周数。 */
export const DEFAULT_PHASE_WEEKS = 8;

/**
 * 各阶段 / 子目标的基准营养目标（未按体重换算）。
 * proteinPerKg 会在 phaseTargets 里乘以用户体重得到 proteinG。
 */
const BASE_TARGETS = Object.freeze({
  performance: Object.freeze({
    fat_loss: Object.freeze({ kcalMin: 1600, kcalMax: 2000, proteinPerKg: 1.6, freeMealsPerWeek: 1 }),
    muscle_gain: Object.freeze({ kcalMin: 2600, kcalMax: 3000, proteinPerKg: 2.0, freeMealsPerWeek: 1 }),
    maintain: Object.freeze({ kcalMin: 2000, kcalMax: 2400, proteinPerKg: 1.6, freeMealsPerWeek: 2 }),
    weight_gain: Object.freeze({ kcalMin: 2800, kcalMax: 3200, proteinPerKg: 1.8, freeMealsPerWeek: 1 }),
  }),
  low_sugar: Object.freeze({
    steady: Object.freeze({ kcalMin: 1700, kcalMax: 2100, proteinPerKg: 1.2, freeMealsPerWeek: 2 }),
    low_gi: Object.freeze({ kcalMin: 1700, kcalMax: 2100, proteinPerKg: 1.2, freeMealsPerWeek: 2 }),
  }),
  low_sodium: Object.freeze({
    low_salt: Object.freeze({ kcalMin: 1800, kcalMax: 2200, proteinPerKg: 1.2, freeMealsPerWeek: 2 }),
    heart: Object.freeze({ kcalMin: 1800, kcalMax: 2200, proteinPerKg: 1.2, freeMealsPerWeek: 2 }),
  }),
  gentle: Object.freeze({
    gentle: Object.freeze({ kcalMin: 1800, kcalMax: 2200, proteinPerKg: 1.2, freeMealsPerWeek: 2 }),
    easy_digest: Object.freeze({ kcalMin: 1800, kcalMax: 2200, proteinPerKg: 1.2, freeMealsPerWeek: 2 }),
  }),
  high_fiber: Object.freeze({
    fiber: Object.freeze({ kcalMin: 1700, kcalMax: 2100, proteinPerKg: 1.2, freeMealsPerWeek: 2 }),
    gut: Object.freeze({ kcalMin: 1700, kcalMax: 2100, proteinPerKg: 1.2, freeMealsPerWeek: 2 }),
  }),
  plant_based: Object.freeze({
    lacto_ovo: Object.freeze({ kcalMin: 1800, kcalMax: 2200, proteinPerKg: 1.2, freeMealsPerWeek: 2 }),
    vegan: Object.freeze({ kcalMin: 1800, kcalMax: 2200, proteinPerKg: 1.1, freeMealsPerWeek: 2 }),
    flexitarian: Object.freeze({ kcalMin: 1800, kcalMax: 2200, proteinPerKg: 1.2, freeMealsPerWeek: 2 }),
  }),
  special: Object.freeze({
    prenatal: Object.freeze({ kcalMin: 2000, kcalMax: 2400, proteinPerKg: 1.4, freeMealsPerWeek: 1 }),
    senior: Object.freeze({ kcalMin: 1800, kcalMax: 2100, proteinPerKg: 1.2, freeMealsPerWeek: 2 }),
    teen: Object.freeze({ kcalMin: 2200, kcalMax: 2600, proteinPerKg: 1.4, freeMealsPerWeek: 1 }),
  }),
  recovery: Object.freeze({
    post_illness: Object.freeze({ kcalMin: 2000, kcalMax: 2400, proteinPerKg: 1.5, freeMealsPerWeek: 2 }),
    post_surgery: Object.freeze({ kcalMin: 2000, kcalMax: 2400, proteinPerKg: 1.5, freeMealsPerWeek: 2 }),
  }),
  treat: Object.freeze({
    treat: Object.freeze({ kcalMin: null, kcalMax: null, proteinPerKg: 1.0, freeMealsPerWeek: 3 }),
    celebrate: Object.freeze({ kcalMin: null, kcalMax: null, proteinPerKg: 0.9, freeMealsPerWeek: 4 }),
  }),
});

/** 已知的目标字段，用于合并自定义 targets。 */
const TARGET_KEYS = Object.freeze(['kcalMin', 'kcalMax', 'proteinG', 'freeMealsPerWeek']);

/**
 * 取有限数字；非法返回 fallback。
 *
 * @param {unknown} value 原始值
 * @param {number | null} fallback 回退值
 * @returns {number | null} 有限数字或 fallback
 */
function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * 判断是否为新阶段 canonical id。
 *
 * @param {unknown} value 值
 * @returns {boolean} 是否合法
 */
export function isPhaseKind(value) {
  return typeof value === 'string' && PHASES.includes(value);
}

/**
 * 把旧阶段名 / 新阶段名标准化为 canonical 阶段 id。
 *
 * @param {object | string | null | undefined} input 阶段对象 / 阶段名 / 空
 * @returns {string | null} canonical 阶段 id 或 null
 */
export function canonicalPhaseKind(input) {
  if (typeof input === 'string') {
    if (PHASES.includes(input)) return input;
    return LEGACY_PHASE_ALIASES[input] ?? null;
  }
  if (!input || typeof input !== 'object') return null;
  return canonicalPhaseKind(input.kind) ?? canonicalPhaseKind(input.phaseKind);
}

/** 兼容别名。 */
export const normalizePhaseKind = canonicalPhaseKind;

/**
 * 取某阶段的子目标列表。
 *
 * @param {string | null | undefined} kind 阶段 id（可旧名）
 * @returns {readonly string[]} 子目标列表
 */
export function subgoalsOf(kind) {
  const canonical = canonicalPhaseKind(kind) ?? 'performance';
  return PHASE_SUBGOALS[canonical] ?? Object.freeze([]);
}

/**
 * 解析旧阶段名（用于 relax→treat(treat)、indulgence→treat(celebrate) 的子目标偏好）。
 *
 * @param {object} source 阶段对象
 * @returns {string | null} 旧阶段名
 */
function legacyKindOf(source) {
  if (typeof source.kind === 'string' && LEGACY_PHASE_ALIASES[source.kind]) return source.kind;
  if (typeof source.phaseKind === 'string' && LEGACY_PHASE_ALIASES[source.phaseKind]) return source.phaseKind;
  return null;
}

/**
 * 解析子目标；不在当前阶段列表内则回退到第一个。
 *
 * @param {string} kind canonical 阶段
 * @param {object} source 阶段对象
 * @returns {string} 子目标
 */
function resolveSubgoal(kind, source) {
  const list = PHASE_SUBGOALS[kind] ?? [];
  if (list.includes(source.subgoal)) return source.subgoal;
  if (list.includes(source.phaseSubgoal)) return source.phaseSubgoal;

  const legacy = legacyKindOf(source);
  if (legacy === 'relax' && list.includes('treat')) return 'treat';
  if (legacy === 'indulgence' && list.includes('celebrate')) return 'celebrate';
  return list[0] ?? 'fat_loss';
}

/**
 * 从 profile 里解析体重（kg），非法回退 75kg。
 *
 * @param {object | null | undefined} profile 用户档案
 * @returns {number} 体重（kg）
 */
function resolveWeight(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const candidates = [source.weight, source.body && source.body.weight, source.identity && source.identity.weight];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 30 && value <= 250) return value;
  }
  return DEFAULT_WEIGHT_KG;
}

/**
 * 归一化阶段对象：非法/缺失输入回退为「训练补给 · 减脂 · 8 周 · 今天开始」。
 *
 * @param {object | null | undefined} [input] 阶段输入（可含 kind/phaseKind、subgoal、start、weeks、targets）
 * @returns {{ kind: string, subgoal: string, start: string, weeks: number, targets: object }} 归一化阶段
 */
export function normalizePhase(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const kind = canonicalPhaseKind(source) ?? 'performance';
  const subgoal = resolveSubgoal(kind, source);

  let start;
  const startInput = source.start === undefined ? source.startDate : source.start;
  if (startInput === undefined) {
    start = todayKey();
  } else {
    try {
      start = toDateKey(startInput);
    } catch {
      start = todayKey();
    }
  }

  const weeksRaw = Number(source.weeks === undefined ? source.phaseWeeks : source.weeks);
  const weeks = Number.isFinite(weeksRaw) ? Math.min(52, Math.max(1, Math.round(weeksRaw))) : DEFAULT_PHASE_WEEKS;

  const targets = phaseTargets({ kind, subgoal, targets: source.targets }, source.profile);
  return { kind, subgoal, start, weeks, targets };
}

/**
 * 计算阶段营养目标。
 *
 * 支持用 `phase.targets` 覆盖基准值（例如用户自定义热量 / 蛋白目标），
 * 并用 `profile.weight` 把蛋白目标从 g/kg 换算成克数。
 *
 * @param {object | string | null | undefined} phase 阶段对象（或阶段名字符串）
 * @param {object | null | undefined} [profile] 用户档案（可含 weight）
 * @returns {{ kcalMin: number | null, kcalMax: number | null, proteinG: number, freeMealsPerWeek: number }} 营养目标
 */
export function phaseTargets(phase, profile) {
  const source = phase && typeof phase === 'object' ? phase : { kind: phase };
  const kind = canonicalPhaseKind(source) ?? 'performance';
  const subgoal = resolveSubgoal(kind, source);
  const stageMap = BASE_TARGETS[kind] ?? BASE_TARGETS.performance;
  const base = stageMap[subgoal] ?? Object.values(stageMap)[0];
  const weight = resolveWeight(profile === undefined ? source.profile : profile);

  let kcalMin = base.kcalMin;
  let kcalMax = base.kcalMax;
  let proteinG = Math.round(base.proteinPerKg * weight);
  let freeMealsPerWeek = base.freeMealsPerWeek;

  const overrides = source.targets && typeof source.targets === 'object' ? source.targets : null;
  if (overrides) {
    for (const key of TARGET_KEYS) {
      if (!(key in overrides)) continue;
      const raw = overrides[key];
      if (key === 'kcalMin' || key === 'kcalMax') {
        if (raw === null) {
          if (key === 'kcalMin') kcalMin = null;
          else kcalMax = null;
        } else {
          const value = finiteOr(raw, null);
          // 0 / 负数视为「未设置」，沿用阶段基准
          if (value !== null && value > 0) {
            if (key === 'kcalMin') kcalMin = value;
            else kcalMax = value;
          }
        }
      } else if (key === 'proteinG') {
        const value = finiteOr(raw, null);
        if (value !== null && value >= 0) proteinG = Math.round(value);
      } else if (key === 'freeMealsPerWeek') {
        const value = finiteOr(raw, null);
        if (value !== null && value >= 0) freeMealsPerWeek = Math.round(value);
      }
    }
  }

  if (kcalMin !== null && kcalMax !== null && kcalMin > kcalMax) {
    [kcalMin, kcalMax] = [kcalMax, kcalMin];
  }
  proteinG = Math.min(400, Math.max(0, proteinG));
  freeMealsPerWeek = Math.min(21, Math.max(0, freeMealsPerWeek));
  return { kcalMin, kcalMax, proteinG, freeMealsPerWeek };
}

/**
 * 取阶段中文标签（含子目标时形如「训练补给 · 减脂」）。
 *
 * @param {object | string | null | undefined} phase 阶段
 * @returns {string} 中文标签
 */
export function phaseLabel(phase) {
  const source = phase && typeof phase === 'object' ? phase : { kind: phase };
  const kind = canonicalPhaseKind(source) ?? 'performance';
  const subgoal = resolveSubgoal(kind, source);
  const label = PHASE_META[kind].label;
  const sub = SUBGOAL_META[subgoal]?.label;
  if (!sub || sub === label) return label;
  return `${label} · ${sub}`;
}
