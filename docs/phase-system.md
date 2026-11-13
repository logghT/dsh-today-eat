# 九类饮食阶段与子目标

> 适用版本：v0.4.0+。旧的「健身 / 健康 / 放松 / 放纵」四阶段仍然可用，会自动迁移到新阶段，历史记录与周计划不丢。

## 1. 阶段总表

| kind | 名称 | 子目标 id | 默认目标（75kg 成人） |
| --- | --- | --- | --- |
| `performance` | 🏋️ 训练补给 | `fat_loss` 减脂 / `muscle_gain` 增肌 / `maintain` 维持 / `weight_gain` 增重 | 1600–2000 / 蛋白 120g；2600–3000 / 150g；2000–2400 / 120g；2800–3200 / 135g |
| `low_sugar` | 🍚 少糖日常 | `steady` 稳糖 / `low_gi` 低 GI | 1700–2200 / 90g |
| `low_sodium` | 🧂 清淡少盐 | `low_salt` 低盐 / `heart` 护心 | 1800–2200 / 90g |
| `gentle` | 🍲 养胃 | `gentle` 清淡养胃 / `easy_digest` 易消化 | 1800–2200 / 90g |
| `high_fiber` | 🥬 高纤维多吃菜 | `fiber` 高纤 / `gut` 肠道友好 | 1700–2100 / 90g |
| `plant_based` | 🌱 多吃素 | `lacto_ovo` 蛋奶素 / `vegan` 纯素 / `flexitarian` 弹性素 | 1800–2200 / 90–105g |
| `special` | 🤰 特殊时期 | `prenatal` 孕期备孕 / `senior` 银发 / `teen` 青少年 | 2000–2400 / 105g；1800–2100 / 90g；2200–2600 / 105g |
| `recovery` | 🫖 养身体 | `post_illness` 病后 / `post_surgery` 术后 | 2000–2400 / 113g |
| `treat` | 🎉 吃的高兴 | `treat` 日常犒劳 / `celebrate` 聚餐庆祝 | 不设热量硬上限 / 蛋白 68–75g |

`freeMealsPerWeek` 仍由 `phaseTargets()` 按阶段给出（训练补给默认 1 次/周，吃的高兴按庆祝场景）。

## 2. 旧阶段迁移

| 旧 kind | 新 kind | 子目标 |
| --- | --- | --- |
| `fitness` | `performance` | 保留原 subgoal；缺省 `fat_loss` |
| `healthy` | `low_sodium` | `low_salt` |
| `relax` | `treat` | `treat` |
| `indulgence` | `treat` | `celebrate` |

迁移发生在 `normalizePhase()` / `normalizePhaseState()`，只改 `phase.kind/subgoal`，不改历史记录、周计划或已记录餐次。

## 3. 阶段适配分怎么算

`src/core/phase-rules.js` 导出：

- `phaseFitFor(dish, kind, subgoal)`：返回 1–5。
  - `performance` 直接复用菜品已有的 `phases.fitness`。
  - `treat` 取 `phases.indulgence` 与 `phases.relax` 的较大值。
  - 其余阶段按营养（`nutrition.kcal/protein/fat/carbs`）、食材、标签、菜系动态计算；不要求 1000 道菜重新打标签。
- `phaseScoreAdjustment(dish, kind, subgoal)`：在推荐分数上做 ±10 的加减。
- `phaseHardEligible(dish, kind, subgoal)`：只对素食阶段硬过滤——`vegan` 排除所有动物性食材，`lacto_ovo` 排除肉/海鲜；其他阶段不做硬过滤。

营养字段统一由 `nutritionOf()` / `metricOf()` 读取（兼容 `dish.nutrition.*` 与顶层旧字段）。

## 4. 接口字段

- `state.phase = { kind, subgoal, weeks, start, targets? }`；`kind` 使用上表 canonical 值，`subgoal` 必须是该阶段的子目标。
- `update_profile` / `recommend_meal` / `plan_week` / `cook_plan` / `find_nearby` 的 `phaseKind` 接受 canonical 或旧别名，内部会归一化。
- 推荐结果与周计划会输出 `phaseKind`（canonical）和 `subgoal`。
- 附近搜索的 `phaseKeywords` 也按 9 阶段生成；旧阶段名会自动映射。

## 5. 测试

- `tests/core/v2-core.test.mjs`：9 阶段枚举、子目标、别名、目标。
- `tests/core/phase-rules.test.mjs`：动态适配分、素食硬过滤、甜口/高碳水扣分、高纤加分。
- 全仓单测 158 项；host smoke 31；client smoke 36。
