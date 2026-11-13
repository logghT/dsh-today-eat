# 菜谱库 v1：全量菜谱 + 「菜谱」页面（contract）

> 状态：**已实现并扩充到 260 道（按地区）**（2026-11-13，v0.2.0）：菜谱 260 道；第 5 个 tab「菜谱」支持搜索、场景筛选、地区筛选与分组；
> 单测 131、host 烟测 31、client 烟测 24。

目标：① 菜谱数量从 60 扩到**覆盖全部 148 道菜**（每道菜都有本地原创菜谱）；② 面板新增第 5 个 tab「菜谱」，
可搜索/筛选/查看全部菜谱详情；③ 每道菜谱仍带外部参考（下厨房/抖音/B站/小红书），不同做法可跳转对比。

## 1. 数据（data/recipes.js、data/dishes.js）

- `RECIPES` 目标 **148 道**，与 `DISHES` 一一对应（`recipe.dishId === dish.id`，`recipe.id` 可沿用 dish id）。
- 每道菜谱字段与现有 60 道完全一致：
  ```js
  { id, dishId, name, servings, prepMin, cookMin, difficulty: '易'|'中'|'难',
    kcal, protein,
    ingredients: [{ name, amount:number, unit, group }],   // group ∈ 蔬菜/肉蛋/水产/豆制品/主食/调料/水果（沿用现有枚举）
    steps: string[] (3–6 条), tips: string[] (0–3 条) }
  ```
- 菜谱文字必须**原创撰写**（家常做法改写，不复制下厨房/抖音等平台原文）；用量/时间/热量合理，与 `dish.nutrition` 量级一致（±30% 内）。
- `dishes.js`：全部 148 道 `cookable: true` 且 `recipeId` 指向对应菜谱（火锅/烧烤/快餐类也写成家庭简化版，例如“家庭版牛油火锅”）。
- 数据校验：`scripts/validate-data.mjs` 与 `tests/data/data.test.mjs` 中硬编码的 60 改为 148（或改为 ≥148），
  保留所有字段/用量/步骤/分组/一一映射校验；`node scripts/validate-data.mjs` 通过。
- 不删除已有 60 道菜谱内容（可微调但保持菜名/步骤质量）。

## 2. 客户端：「菜谱」tab（src/client）

- `format.js` 的 `PANEL_TABS` 增加 `{ id:'recipes', label:'菜谱', emoji:'📖' }`（放在「本周」之后、「记录」之前）。
- 新文件 `src/client/tabs/recipes.jsx`，在 `panel.jsx` 中按 activeTab 渲染；面板标题区显示菜谱总数（如「菜谱库 · 148 道」）。
- 页面能力：
  1. **搜索框**：按菜名 / 食材 / 菜系模糊匹配（不区分大小写；中文包含即可）。
  2. **筛选 chips**：`全部`、`快手 ≤20 分钟`（prep+cook）、`高蛋白 ≥25g`、`云南`、`川菜`、`汤羹`、`素菜`（tags 含 veg）；可组合（搜索 + 一个筛选）。
  3. **列表**：卡片/行显示 菜名、菜系、难度、总时长、kcal/蛋白、主要食材前 3；点击展开详情（inline 或选中态详情区）：用量按 group 分组、步骤、tips、外部参考链接（复用 `src/core/reference.js` 的 `referenceLinksOf`，样式同 today.jsx 的 `.tde-recipe-refs`）。
  4. 空态：筛选无结果时给出「换个关键词/筛选」提示 + 清空按钮。
  5. 不新增依赖；样式沿用 `--dsw-alias-*`；移动/窄面板可滚动。
- `scripts/smoke-client.mjs`：新增用例（PANEL_TABS 含 recipes；`__test` 暴露 recipes 过滤函数；菜谱页有搜索/筛选/列表；静态字符串包含「菜谱库」或「全部菜谱」）；原有 13 项保持全绿。
- 构建 `lib/client.js` 成功可重复，产物仍是 ModuleLoader 经典脚本、只 require baseline。

## 3. Host / 工具

- `cook_plan` 继续按 dish.recipeId 查菜谱；菜谱变多后随机/推荐可选中更多自制菜（现有逻辑无需改）。
- `meal_stats` 等不受影响；无需改 host 工具（除非数据校验脚本在 lib 范围外由数据任务修改）。

## 4. 验收

- `node scripts/validate-data.mjs` 通过，输出菜谱 148 道。
- `node --test "tests/core/*.test.mjs" "tests/data/*.test.mjs" "tests/host/*.test.mjs"` 全绿。
- `node scripts/smoke-host.mjs` 31 项、`node scripts/smoke-client.mjs` ≥14 项全绿。
- 真机（Electron 探针）：面板出现第 5 个 tab「菜谱」；搜索「鸡」有结果；筛选「快手」结果均 ≤20 分钟；点开一道菜看到步骤/用量/外部参考链接。

## 5. 写作分工

- `menu-data`：只写 `data/recipes.js`、`data/dishes.js`、`scripts/validate-data.mjs`、`tests/data/`。
- `butler-ui`：只写 `src/client/`（format.js、panel.jsx、tabs/recipes.jsx、panel.css、recipes.js 等）、`scripts/smoke-client.mjs`。
- Lead：契约、集成、README/docs、真机验证、最终 gate。
