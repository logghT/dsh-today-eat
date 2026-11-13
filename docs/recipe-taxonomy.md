# 菜谱分类 v2：国家 / 菜系 / 省份 + 扩充到 1000 道（contract）

> 状态：**已实现**（2026-11-13，v0.4.0）：**1000 道菜/菜谱**，国家 16、省级行政区 34/34 全覆盖；**云南菜独立成系（109 道，西南剩 66）**；本轮在原 500 道基础上 +500（分 5 批并行原创，原 500 道全部保留），并完成同名去重与 24 道补位；下文的 400 道是更早一轮契约，已在后续扩容中按同一 schema 继续加法扩充。
> 菜谱页支持国家/菜系/省份筛选与分组切换；最新单测 145、host 31、client 36。

目标：① 菜谱/菜品从 **260 → 400 道**（+140，全部原创、全可自制）；② 每道菜有 **国家 / 省份 / 菜系** 三个分类维度；
③ 「菜谱」tab 支持按这三个维度筛选，并可切换分组方式（按国家 / 按菜系 / 按省份）。

## 1. 数据字段（data/dishes.js）

每道菜新增两个字段（原有字段不变）：
```js
country: '中国' | '日本' | '韩国' | '美国' | '意大利' | '法国' | '泰国' | '越南' | '印度' | '墨西哥' | '西班牙' | '英国' | '土耳其' | ...
province: string | null  // 仅 country==='中国'：标准省级行政区（云南/四川/重庆/贵州/广西/广东/湖南/湖北/河南/河北/山东/山西/陕西/甘肃/青海/宁夏/新疆/西藏/内蒙古/辽宁/吉林/黑龙江/北京/天津/上海/江苏/浙江/安徽/福建/江西/海南/台湾/香港/澳门）；国外菜为 null
```
- 原有 260 道必须补齐 country/province（映射规则：origins 中具体省份/城市优先；「北方」→ 山东；「江浙」→ 江苏；「西南」→ 云南；「东北」→ 辽宁；国外 origins → 对应 country）；不许留空。
- `cuisine` 共 11 类：云南菜/川菜/粤菜/湘菜/江浙/北方/西北/西南/日韩/西式/快餐（国外菜用 日韩 或 西式）。云南菜独立：37 道、全部 province=云南；西南仅保留重庆/四川/广西/贵州（14 道）。
- 新增 140 道分布（可微调，但全覆盖）：
  - 中国省份：每个省级行政区至少 2 道（现有不足的补齐：福建/江西/安徽/河北/山西/天津/宁夏/青海/西藏/香港/澳门/台湾/黑龙江/吉林/辽宁/内蒙古/海南/湖北/河南 等）；
  - 新增地区菜：东北（锅包肉/地三鲜/杀猪菜…）、西北（宁夏手抓羊肉/青海酿皮/新疆烤包子…）、华中（热干面/胡辣汤/剁椒…已有则补）、华东（徽州臭鳜鱼/福建佛跳墙/江西瓦罐汤/上海生煎…）等；
  - 国家：日本/韩国/泰国/越南/印度/美国/意大利/法国/墨西哥/西班牙/英国/土耳其/地中海等各 2–6 道；新增 `country` 值；
  - 菜谱全部原创中文 3–6 步、用量数字+单位+七类分组、tips 0–2；kcal/protein 与 dish 一致（±30%）。
- 菜谱数 = 菜品数 = 400，`cookable:true`、recipeId 一一对应；原 260 道不删减/不降质。
- `scripts/validate-data.mjs` 与 `tests/data/data.test.mjs`：数量 260→400；新增 country/province 校验（合法值、中国菜必须有省份、国外菜 province=null、省级行政区覆盖 ≥30）；保留原 260 / 200 / 148 基线校验。

## 2. 客户端「菜谱」tab（src/client）

- 数据层 `recipe-library.js` 为每条 entry 增加 `country / province / cuisineLabel`；导出国家/省份/菜系列表与纯函数：
  `recipeCountriesOf(entries)`、`recipeProvincesOf(entries)`、`recipeCuisinesOf(entries)`、`countByCountry/Cuisine/Province`、`filterRecipes({query, scene, country, cuisine, province})`、`groupRecipes(entries, by)`。
- UI（保持现有搜索 + 场景筛选 + 动态计数）：
  1) **国家筛选行**：`全部国家` + 数据中出现的国家（中国/日本/韩国/美国/意大利/法国/泰国/越南/印度/墨西哥/西班牙/英国/土耳其…），带数量；
  2) **菜系筛选行**：`全部菜系` + 11 菜系（含云南菜），带数量；
  3) **省份筛选**：`全部省份` + 中国省级行政区（用 select 下拉，避免 30+ chips 撑爆宽度；仅 country=中国 时可选；选中「全部国家」时也显示中国省份选项，国外菜不在省份筛选中出现）；带数量。
  4) 搜索 + 场景 + 国家 + 菜系 + 省份 可任意组合；「共 N 道 · 当前显示 M 道」动态。
  5) **分组切换**：`按国家 / 按菜系 / 按省份` 三个 segment；列表按所选维度分组，组标题 + 数量；筛选生效时仍按组显示。
  6) 每张卡片显示 国家/省份/菜系 小标签；详情保留用量分组/步骤/tips/4 条外部参考。
- `scripts/smoke-client.mjs`：新增动态用例（国家/菜系/省份计数与独立计算一致、三组合筛选子集、分组标题数量、云南/四川等省份结果符合、省份 select 存在）；不硬编码 400 或具体计数；原 24 项全绿。
- 构建可重复；产物仍 ModuleLoader 经典脚本、只 require baseline；400 道后 bundle 约 1.1–1.3MB 属正常，注意首屏卡顿（可接受；不做虚拟滚动）。

## 3. Host / 工具

- 工具无需改逻辑；菜谱/菜品增加字段不影响 cook_plan/recommend/plan（仍按 dish.recipeId）。
- `data` 校验脚本与 tests/data 在数据任务范围；host smoke 31 项保持全绿。

## 4. 验收

- `node scripts/validate-data.mjs`：菜品/菜谱 400，国家/省份校验通过。
- `node --test tests/core+data+host` 全绿；`smoke-host` 31、`smoke-client` ≥28 全绿。
- 真机：菜谱页显示「菜谱库 · 1000 道」；国家行、菜系行、省份 select、分组切换可用；点「云南菜」只剩 109 道；分组切「按省份」出现省份小标题。
- 不抓取第三方内容；菜谱为原创撰写。

## 5. 分工

- `menu-data`：data/dishes.js、data/recipes.js、scripts/validate-data.mjs、tests/data/。
- `butler-ui`：src/client/（recipe-library.js、tabs/recipes.jsx、format.js 如需、panel.css、index.js __test）、scripts/smoke-client.mjs。
- Lead：契约、集成、README/docs、真机截图、最终 gate。
