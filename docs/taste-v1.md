# 味道偏好 v1：酸甜苦辣咸鲜 六维统计（contract）

> 状态：**已实现**（2026-11-13，v0.2.0）。实现见 `src/core/taste.js`、`src/client/taste.js`、
> `src/client/tabs/settings.jsx`、`src/client/tabs/history.jsx`、`lib/state.js`、`lib/tool.js`；
> 验证：单测 123/123、host 烟测 31、client 烟测 13。

目标：把「味道偏好」统一成 **酸 / 甜 / 苦 / 辣 / 咸 / 鲜** 六个维度（0–5），
同时用于：① 档案设置；② 推荐打分；③ 长期记录的「口味画像统计」；④ 模型工具输出。

## 1. 维度枚举（唯一真源）

```js
export const TASTE_DIMENSIONS = ['sour', 'sweet', 'bitter', 'spicy', 'salty', 'umami']
export const TASTE_LABELS = { sour:'酸', sweet:'甜', bitter:'苦', spicy:'辣', salty:'咸', umami:'鲜' }
```

- 取值 0–5（允许 1 位小数），0 = 完全不要/无感，5 = 非常喜欢/非常明显。
- 用户档案：`profile.taste = { sour, sweet, bitter, spicy, salty, umami }`；
  `oiliness`（油腻接受度）、`adventurous`（尝鲜意愿）保留为**非味道偏好**，不删除。
- 旧字段迁移（必须兼容已有 state.json）：
  ```
  sour      = max(old.sour ?? 0, old.sourFruit ?? 0, old.sourFermented ?? 0, old.sourVinegar ?? 0) || 3
  spicy     = old.spicy ?? 3
  sweet     = old.sweet ?? 2
  bitter    = old.bitter ?? 1
  salty     = old.salty ?? 2
  umami     = old.umami ?? 3
  ```
  迁移后保留旧字段（不删），新字段为准。

## 2. 菜品味道画像（派生，不改 data/dishes.js）

`dishTasteOf(dish)` 返回 `{ sour, sweet, bitter, spicy, salty, umami }`（1–5，确定性规则）：

- **spicy**：tags 里 `hot`→5、`medium`→3、`mild`→2、无→1；描述/名称含「爆辣/重辣/特辣」+1（上限 5），「微辣」→2。
- **sour**：`dish.sour` 三值取最大（0–5）直接作为基线；名称/描述/食材含 酸/醋/柠檬/青柠/酸汤/泡菜/酸菜/番茄/酸木瓜/酸角 → 至少 3（含「酸汤/酸木瓜/柠檬」→4）。
- **sweet**：名称/描述/食材含 糖/蜜/甜/拔丝/糖醋/蜜汁/汤圆/糕点/糖水/菠萝饭 → 3–5；菜系江浙/粤菜 +1；否则 2。
- **bitter**：名称/描述/食材含 苦瓜/苦菜/苦荞/苦菊/芥菜/咖啡/茶/苦 → 3–5；否则 1。
- **salty**：名称/描述/食材含 咸/腌/卤/酱/盐水/咸菜/腊/火腿/培根/咸鱼/酱香 → 3–5；菜系北方/西北 +1；汤羹 +1；否则 2。
- **umami**：食材含 鱼/虾/蟹/贝/鸡/牛/猪/菌/菇/豆腐/酱油/蚝油/高汤/海带/紫菜 → 3–5；tags 含 seafood/soup +1；名称/描述含 鲜/汤/炖/蒸/高汤 → 至少 3；否则 2。

全部 clamp 到 1–5 并四舍五入到整数（统计页可再展示 1 位小数）。

## 3. 核心 API（src/core/taste.js，保留旧导出）

```js
export const TASTE_DIMENSIONS, TASTE_LABELS
export function normalizeTaste(input) -> {sour,sweet,bitter,spicy,salty,umami}   // 含旧字段迁移
export function dishTasteOf(dish) -> 六维 1-5
export function tasteMatch(dish, profile) -> number  // -2..+2，profile.taste 与 dish 六维的加权相似度
export function tastePreferenceOf(profile) -> 六维 0-5（normalizeTaste）
export function summarizeTaste(meals, catalog, profile) -> {
  samples, dimensions: [{ id, label, value, liked, disliked }], topTastes: [id...], summary: string
}
export function learnFromMeal(profile, dish, rating) -> profile  // 保留，EWMA 学习六维（profile.taste）
```

统计规则（`summarizeTaste`）：
- meals 里每条按 `dishId` 从 catalog 找菜（找不到则跳过）；权重：rating=1 → 1.5，rating=-1 → 0.5，其余 1。
- 每个维度 value = Σ(菜维度 × 权重) / Σ权重，保留 1 位小数；`liked`/`disliked` 为该维度上喜欢/不喜欢次数。
- 无记录时 value 回退到 `normalizeTaste(profile.taste)`，`samples=0`，summary 用「偏好设置」而非「统计」。
- `summary` 中文示例：`偏爱：酸、辣、鲜`（取 value≥4 的前 3 个；不足 3 个取 value 最高的 2 个；全低时 `口味均衡`）。
- 旧导出 `dishSpicyRank / dishSourOf / dishOilinessOf / tasteProfileOf` 保留并基于新六维实现，避免 client/host 旧代码报错。

## 4. 推荐打分（client/host 共用的 core）

- `tasteMatch`：`sum((pref[i]-3)*(dish[i]-3)) / 30`（六维，clamp -1..1）再放大到 ±2。
- 现有 `dishScore` 对 `tasteMatch` 的权重不变；`recommendMeal` 的 reason 增加「口味匹配」信息：
  例如 `酸辣鲜匹配`（取 dish 六维与偏好差值最小的 2–3 维，或 dish 值≥4 的维度）。
- 迁移后旧档案也能正常打分（normalizeTaste）。

## 5. 界面（client）

- **设置 → 档案**：把原「辣度偏好 / 果酸偏好」两块替换为「味道偏好」六行滑块：
  `酸（柠檬/醋/酸汤）`、`甜（糖/蜜/甜口）`、`苦（苦瓜/苦荞/茶）`、`辣（辣椒/花椒）`、`咸（腌制/卤味）`、`鲜（菌菇/海鲜/高汤）`；0–5，实时保存；油腻接受度/尝鲜意愿保留在下方。
- **记录 → 口味画像**：新增六维横向条形图（酸/甜/苦/辣/咸/鲜 + 数值），数据来自 `summarizeTaste`；
  无记录时显示「还没有记录，先显示你的偏好设置」；顶部显示 summary（如「偏爱：酸、辣、鲜」）。
- 面板「今天」推荐理由里如含口味信息则展示（core reason 已带）。
- 所有文案中文；沿用 `--dsw-alias-*` 变量；不新增依赖。

## 6. Host 半

- `lib/state.js`：默认 `profile.taste` 六维默认值 `{sour:3,sweet:2,bitter:1,spicy:3,salty:2,umami:3}`；
  读取旧 state 时迁移（保留旧字段）；normalize 时确保六维存在且 0–5。
- `lib/tool.js`：
  - `update_profile` 新增参数：`sour/sweet/bitter/spicy/salty/umami`（number 0-5，全部可选），
    同时保留旧参数 `sourFruit/sourFermented/sourVinegar`（映射到 sour=max）与 `sweet/spicy` 兼容；
    render 输出六维摘要（如「味道偏好：酸4 甜3 苦2 辣3 咸2 鲜4」）。
  - `meal_stats`：输出 schema 增加 `taste: { dimensions:[{id,label,value,liked,disliked}], summary }`；
    render 追加一行「口味画像：酸 3.2 · 甜 2.1 · 苦 1.4 · 辣 4.1 · 咸 2.8 · 鲜 3.6」。
  - `recommend_meal` render 摘要可带「酸辣鲜匹配」之类（取 core reason）。
- host 工具为纯计算，不联网、不写 fs（state 除外）。

## 7. 验收

- `src/core` 单测：六维迁移、dishTasteOf 规则、tasteMatch 方向、summarizeTaste 权重/回退、旧导出兼容。
- client 单测/烟测：设置页六滑块写 profile.taste；记录页口味画像六维条；无记录回退偏好。
- host 测试：update_profile 六维参数、旧参数兼容；meal_stats taste 字段与 render；state 默认/迁移。
- 真机：设置里调「酸/辣/鲜」→ 推荐变化（含酸辣菜）；记录一餐后「口味画像」数值变化；重新加载后保持。
- 构建 `lib/client.js` 可重复；host 热加载后可调工具。
