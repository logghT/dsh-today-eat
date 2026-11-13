# 今天吃什么 v2 — 饮食管家设计规格（authoritative）

> 本文件是 v2 迭代的唯一契约来源。所有实现成员以本文件 + 各自任务描述为准；
> 接口/字段有疑问时先按本文件实现，并在报告里列出偏差，不要自行改契约。

## 0. 目标与用户场景

示例用户：偏好酸辣、喜欢天然果酸，常驻城市可自行设置。
需求：长期记录饮食；按「阶段类型」（健身/放松/健康/放纵）推荐；每天饭点主动提醒；
外食给附近餐厅 + 点单建议；自制给菜谱 + 菜市场采买清单；一周不重样。

## 1. 不可违背的技术约束（DSH 0.2.2-rc.1，已实测）

1. 插件以 `link:<你的插件目录>` 安装。**host 半不得 import 任何 `@deepseek-ai/*` 包**（解析不到）；只用相对 import 与 node 内置模块。
2. client bundle 必须是经典脚本：`window.__ModuleLoader__.load({id:'dsh-today-eat', factory:(require)=>{...return plugin}})`；只可 require `react`、`react-dom`、`react/jsx-runtime`；由 esbuild 构建（`scripts/build-client.mjs`）。
3. Web GUI 端口随机（`port: 0`），**localStorage 不可作长期存储**。长期状态存 host 文件，client 通过插件 HTTP 路由读写。
4. 宿主已有 `ctx.webServer` 服务：`ctx.webServer.register({method, path, handler})`（参考 dsh-whale-widget 的 registe rRoute 用法）。Electron 渲染层通过同源 IPC fetch 桥访问，路径写绝对路径 `/dsh-today-eat/...`。
5. 写接口必须做同源 + 回环校验：`Origin` 的 host 必须等于请求 `Host`；写请求（POST/DELETE）只允许回环来源；必须 `content-type: application/json`；失败返回 403/415。
6. 客户端插件挂载点：
   - 横条：`conversation.input.dock`（list/session，现有实现保留并升级）
   - 面板：右栏 tab。参考 dsh-context/lib/client.js 的注册方式：
     ```
     ctx.inject(['sidebarRightTabs'], (scope) => {
       try {
         const tabs = scope.sidebarRightTabs
         tabs.register({ id:'dsh-today-eat', kind:'dsh-today-eat', title:()=>'今天吃什么',
           guide:[{id:'dsh-today-eat', order:30, title:()=>'今天吃什么', description:()=>'饮食管家'}] })
         scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register(
           { name:'sidebar.right.pane.tab', key:'dsh-today-eat' }, Panel))
         scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register(
           { name:'sidebar.right.pane.tab.title', key:'dsh-today-eat' }, Title))
       } catch { /* 失败不影响横条 */ }
     })
     ```
     打开面板：`ctx.inject(['sidebarRight'], s => s.sidebarRight?.openTab?.('dsh-today-eat'))`（拿不到就静默失败，横条仍可用）。
7. 改动后：host 半文件保存即热重载；client 需 `& $node scripts/build-client.mjs`（DSH 会热加载新 bundle）。安装/重新启用：plugin_manager `set_bundle` false→true。

## 2. 状态模型 `state.json`（host 持久化，路径 `<DSH_HOME>/storages/dsh-today-eat/state.json`）

`DSH_HOME` 取 `process.env.DSH_HOME`，缺省 `~/.dsh`。原子写：写 `state.json.tmp` 后 rename；读失败/损坏时回退 `{}` 并备份为 `state.json.bad-<ts>`。

```jsonc
{
  "version": 3,
  "rev": 1,                         // 每次写 +1；client 携带期望 rev，冲突返回 409
  "profile": {
    "identity": { "hometown": "", "city": "", "district": "",
                  "region": "", "lat": null, "lng": null, "adcode": "" },
    "taste": { "spicy": 3, "sour": 3, "sweet": 3,
               "bitter": 3, "salty": 3, "umami": 3 },
    "dietary": { "vegetarian": false, "allergies": [], "avoidTags": [] },
    "budget": { "perMeal": [20, 60], "weekly": 420 },
    "cook": { "skill": "basic", "equipment": ["炒锅","电饭煲"], "weekdayCookMin": 20 }
  },
  "phase": { "kind": "fitness", "subgoal": "fat_loss", "start": "2026-11-09", "weeks": 8,
             "targets": { "kcalMin": 1600, "kcalMax": 2000, "proteinG": 120, "freeMealsPerWeek": 1 } },
  "meals": [ { "id": "m-...", "ts": 0, "date": "2026-11-09", "meal": "lunch",
               "mode": "home", "dishId": "lemon-chicken-breast", "dishName": "柠檬手撕鸡胸",
               "place": null, "rating": 0, "note": "", "kcal": 420, "proteinG": 38 } ],
  "plan": { "start": "2026-11-09", "seed": 7, "generatedAt": 0,
            "locked": {}, "picks": [ { "date": "2026-11-09", "meal": "lunch", "dishId": "...", "mode": "home" } ] },
  "settings": {
    "mealTimes": { "breakfast": ["07:00","09:00"], "lunch": ["11:30","13:00"], "dinner": ["17:30","19:30"] },
    "plannedMeals": ["lunch","dinner"],
    "notify": { "inApp": true, "system": true, "snoozeMin": 30 },
    "amapKey": ""
  },
  "ui": { "collapsed": false, "panelTab": "today" }
}
```

`phase.kind` 四选一：`fitness`（健身）| `healthy`（健康）| `relax`（放松）| `indulgence`（放纵）。
`phase.subgoal` 仅 fitness 用：`fat_loss`（减脂）| `muscle_gain`（增肌）| `maintain`（维持）。
`getState` 返回时把 `settings.amapKey` 替换为 `""`，并返回 `hasAmapKey: boolean`。

## 3. HTTP API（host 注册于 `ctx.webServer`，全部走同源绝对路径）

| Method | Path | Body/Query | 返回 |
| --- | --- | --- | --- |
| GET | `/dsh-today-eat/api/state` | – | `{state, hasAmapKey}` |
| POST | `/dsh-today-eat/api/state` | `{rev, patch}` patch 仅允许 `profile/phase/settings/ui`（深合并） | `{state, hasAmapKey, rev}`；rev 不符 409 `{code:'rev-mismatch', state}` |
| POST | `/dsh-today-eat/api/meals` | `{rev, meal}` id 为空则新增；同 date+meal 的旧记录替换 | `{state, rev}` |
| DELETE | `/dsh-today-eat/api/meals?id=` | – | `{state, rev}` |
| POST | `/dsh-today-eat/api/plan` | `{rev, plan}` | `{state, rev}` |
| POST | `/dsh-today-eat/api/amap-key` | `{key}` 空串清除 | `{hasAmapKey}` |
| GET | `/dsh-today-eat/api/nearby?meal=lunch&radius=1500` | – | `{ok:true, weather?, items:[...], suggestions:[...]}` 或 `{ok:false, code:'amap-key-missing', fallbackQueries:[...]}` |
| GET | `/dsh-today-eat/api/shopping?days=3` | – | `{ok:true, window, groups:[{group,items:[{name,amount,unit}]}], estimatedCost, missingRecipes:[]}` |

统一错误：`{ok:false, code, message}`，HTTP 400/403/404/409/415/500。
GET 也做同源校验（Origin 若存在必须等于 Host）；无 Origin 的 curl 允许。

## 4. 菜品数据 `data/dishes.js`（在现有 98 道基础上扩展，成员 menu-data 负责）

保留现有字段（id/name/emoji/category/cuisine/tags/price/description），新增：

```jsonc
{
  "phases": { "fitness": 1-5, "healthy": 1-5, "relax": 1-5, "indulgence": 1-5 },
  "nutrition": { "kcal": 420, "protein": 38, "fat": 12, "carbs": 45, "veg": 2 }, // veg=蔬菜份数
  "sour": { "fruit": 0-5, "fermented": 0-5, "vinegar": 0-5 },
  "origins": ["云南"],            // 菜系归属地，可为空数组
  "ingredients": ["鸡胸肉","青柠","小米辣"], // 用于忌口硬过滤
  "cookable": true,               // 是否进入自制模式
  "recipeId": "lemon-chicken-breast" // 可自制时必填，对应 recipes.js
}
```

目标规模：≥140 道（新增 ≥45 道，重点云南/川味/健身友好），全量字段完整。
`tags` 规则沿用现有（辣度 mild/medium/hot + meat/veg/seafood + 结构 tag）。

## 5. 菜谱 `data/recipes.js`（成员 menu-data 负责）

```jsonc
{
  "id": "lemon-chicken-breast",      // 与 dish.recipeId 对应
  "dishId": "lemon-chicken-breast",
  "name": "柠檬手撕鸡胸",
  "servings": 1,
  "prepMin": 10, "cookMin": 15, "difficulty": "易",
  "kcal": 420, "protein": 38,
  "ingredients": [ { "name": "鸡胸肉", "amount": 150, "unit": "g", "group": "肉蛋" } ],
  "steps": ["鸡胸冷水下锅…", "…"],
  "tips": ["青柠汁最后放，果酸更清爽"]
}
```

数量：**60 道**（与 dish 一一对应；其中 ≥30 道云南/川味健身改良版，如：柠檬手撕鸡胸、酸木瓜炖鸡、香茅烤鸡胸、
傣味凉拌木耳、酸辣鸡丝荞麦面、番茄酸汤鱼片、少油酸汤肥牛、青柠虾仁沙拉、糊辣鸡胸、酸角汁烤鸡腿、
健身版凉拌米线、酸辣魔芋丝、香茅柠檬烤鱼、酸腌菜炒鸡胸……）。菜谱是原创中文，步骤 3–6 步、用量给数字，
不要复制下厨房等平台原文。

## 6. 城市/大区 `data/cities.js`（成员 menu-data 负责）

`export const CITIES = [...]`（≥60 个城市，用户可在设置里选择）：
`{ name, province, region, district, lat, lng, adcode, tier, cuisines:[...], specialties:[...] }`
另导出 `REGIONS`（西南/华东/华北/华南/华中/西北/东北）与 `findCity(name)`。

## 7. 推荐内核 `src/core/*`（成员 feed-core 负责；host 与 client 共用）

保留现有导出（`getDailyPick/reroll/recordPick/pruneHistory/inferMeal/normalizePreferences/MEALS/CATEGORIES/CUISINES/SPICY_LEVELS`）
与现有 `tests/core/recommend.test.mjs` 全绿。新增：

```js
// src/core/phase.js
export const PHASES = ['fitness','healthy','relax','indulgence']
export const PHASE_META = { fitness:{label:'健身', desc:'高蛋白低油，控热量', emoji:'💪'}, ... }
export function normalizePhase(input) -> phase        // 默认 fitness/fat_loss/8周/今天开始
export function phaseTargets(phase, profile) -> {kcalMin,kcalMax,proteinG,freeMealsPerWeek}

// src/core/taste.js
export function tasteMatch(dish, profile) -> number   // -2..+2，含辣度、果酸/发酵酸/醋酸、油腻、菜系亲和（云南+川菜）
export function learnFromMeal(profile, dish, rating) -> profile  // rating: 1喜欢 / -1不喜欢 / 0中性，更新 learned 亲和度（EWMA）

// src/core/scoring.js
export function dishScore(dish, ctx) -> number        // ctx={profile,phase,history,date,meal,mode,sourBias?}

// src/core/recommend.js（扩展，不破坏旧 API）
export function recommendMeal({date, meal, profile, phase, history, catalog, excludeIds, seed, mode, phaseKind}) 
  -> {dish, alternatives: Dish[3], reason, nutrition, meal, date, phaseKind}
export function planWeek({startDate, days=7, meals=['lunch','dinner'], profile, phase, history, catalog, seed, locked})
  -> {start, seed, days:[{date, meals:[{meal,dish,mode}]}], summary:{avgKcal,avgProtein,uniqueDishes,cuisines,estimatedCost,freeMeals}}
export function summarizeMeals({meals, phase, profile, today})
  -> {streak, loggedDays, repeatRate, avgKcal, avgProtein, adherence, topCuisines, freeMealsUsed}

// src/core/shopping.js
export function buildShoppingList({plan, recipes, days=3, servings=1, profile})
  -> {window:{from,to}, groups:[{group, items:[{name,amount,unit}]}], estimatedCost, missingRecipes}
export function recipeForDish(recipes, dishId)

// src/core/mealTime.js
export function mealTimeState(now, settings, meals) -> {meal, phase:'before'|'in'|'after'|'closed', nextMeal, nextAt, shouldNotify}
```

算法要求：
- 硬过滤：素食、allergies/avoidTags、辣度上限（profile.taste.spicy 映射 mild/medium/hot）、预算、城市可得性（dish.regions 包含 profile.region 或为空）。
- 阶段：先按 `dish.phases[kind]>=2` 过滤（无解时逐步放宽并写 fallbackNote），再按 phase 权重 + 营养目标打分（fitness: 蛋白高/热量进目标带加分，油炸重油扣分）。
- 口味：`tasteMatch` 覆盖辣度、果酸偏好（云南果酸加权最高）、菜系亲和；`history` 最近 7 天同 dish 排除、14 天降权。
- 周计划：贪心 + 局部 swap，20 次迭代；硬约束无重复（7 天内）、阶段允许；软目标菜系/蛋白来源/蔬菜多样性；结果对同 (seed,start,phase,profile) 确定性。
- 营养目标默认：fitness fat_loss 1600–2000 kcal / protein 1.6g/kg(按 75kg→120g)，muscle_gain 2600–3000 / 150g，maintain 2000–2400 / 120g；healthy 1800–2200；relax/indulgence 不设热量硬上限但记录。

## 8. Host 半（成员 host-store 负责；lib/ 全部）

文件：`lib/state.js`（读写/迁移/原子写）、`lib/api.js`（routes + 校验）、`lib/amap.js`（POI/天气/地理编码 + 缓存）、`lib/tool.js`（工具定义，纯逻辑 + 假 ctx 可测）、`lib/index.js`（插件入口：`inject:['tools','webServer']`，注册工具与路由，卸载时 dispose）。

工具（raw JSON Schema，中文 description，全部可选参数）：
1. `update_profile` — 参数：hometown/city/district/region/taste(spicy,sourFruit,…)/dietary/allergies/budget/phaseKind/phaseSubgoal/phaseWeeks；返回更新后的档案摘要文本。
2. `recommend_meal` — meal/mode/phaseKind/excludeIds/context(weather,mood)；返回 dish/nutrition/reason/alternatives；render 中文摘要。
3. `plan_week` — days/meals/phaseKind/regenerate；返回周计划 + 摘要；render 表格文本。
4. `cook_plan` — dishId（省略则按当前餐次推荐）; 返回菜谱（步骤/用量）+ 采买清单；render 中文步骤 + 采购分区。
5. `find_nearby` — meal/radius/keywords；host 调 Amap（Key 未配置时返回 fallbackQueries 与提示）；返回 items+suggestions。
6. `log_meal` — dishId/dishName/meal/mode/rating/note；写入 state 并返回最新统计摘要。
7. `meal_stats` — days；返回连续记录/重复率/营养依从/口味画像。

`/food` 命令：`/food`（今日推荐）、`/food 附近`、`/food 周计划`、`/food 自己做`、`/food 统计`；handler 返回 `{kind:'success', text}`（纯文本，200 字内）。

Amap 细节（`lib/amap.js`）：
- Base `https://restapi.amap.com/v3`；用 Node 全局 `fetch`。
- `geocodeCity(city)`：`/geocode/geo?address=...&key=` → location/adcode；保存到 profile.identity 由调用方决定。
- `searchNearby({key, lng, lat, keywords, radius=1500, maxCost})`：`/place/around?key&location=lng,lat&radius&types=050000&keywords&offset=25&page=1&extensions=all`；
  结果过滤/编译：`name,address,distance,rating(biz_ext.rating),cost(biz_ext.cost),tel,type,location`；距离≤radius、rating≥4.0、cost≤budget 上限。
- `weather({key, adcode})`：`/weather/weatherInfo?city=<adcode>&extensions=all` → 今天白天天气/温度。
- 所有请求 8s 超时、失败返回结构化错误不抛到 HTTP 顶层；内存缓存 10 分钟。
- 关键词按 phase 生成：fitness `轻食|沙拉|鸡胸|酸汤鱼|荞麦面|蒸菜|清汤`；healthy `少油|清汤|蒸|粥|蔬菜`；relax `汤锅|面馆|砂锅|酸辣`；indulgence `火锅|烧烤|自助|川菜`。
- 点单建议：`src/core/chain-menu.js` 维护常见连锁品牌的公开菜单单品（35 个），命中品牌按阶段给具体选法并注明「以门店为准」；查不到公开菜单的小店只建议到店看菜单/问招牌，不按店名编菜名。`lib/amap.js#searchNearby` 为每个 POI 附 `suggestion`/`orderKind`，`lib/tool.js` 与面板都会逐店展示。

## 9. Client 半（成员 butler-ui 负责；src/client/、scripts/smoke-client.mjs）

- `api.js`：fetch 封装（GET state / POST patch/meals/plan/amap-key / GET nearby/shopping），rev 冲突自动重拉，接口不可用（404/网络错误）回退 localStorage 离线模式并暴露 `offline:true`。
- 状态：一个 `useSyncExternalStore`/自定义 store 的 app store（profile/phase/state/mealTime），60s 轮询 + focus 刷新 + 请求后更新。
- 迁移：首次 GET state 若 `meals` 空且 localStorage 有旧 `dsh-today-eat:history:v1`，POST 迁移为 meals（date/meal 缺失按未知填 `lunch`/当天），迁移成功后保留旧键不删。
- 横条（dock）升级：显示阶段 emoji + 当前/下一餐 + 推荐菜 + 营养(蛋白/热量) + 按钮：`附近吃` `自己做` `换一个` `我吃了`；饭点窗口内显示「🔔 午饭时间到」；收起态保持；按钮打开面板（sidebarRight.openTab）。
- 面板（右栏 tab，`Panel` 组件，内部 4 个 tab）：
  - 今天：餐次横幅 + 大卡片（营养 vs 目标进度条）+ 备选 + 附近（点按钮加载 Amap，无 Key 时提示去设置）+ 自制（菜谱步骤 + 采买清单）。
  - 本周：滚动 7 天午/晚餐列表、重新规划、锁定单日、周摘要（均热量/蛋白、不重复菜数、菜系数、预估花费）。
  - 记录：统计卡（连续记录、7 天不重样率、蛋白达标率、自由餐次数）、最近 28 天热力/方块图、记录列表（评分/删除）、导出 JSON。
  - 设置：档案（家乡/城市/区/大区/辣度/果酸偏好/忌口/预算）、阶段（4 类 + 周数 + fit 子目标）、饭点时间、提醒开关 +「开启系统通知」按钮（Notification.requestPermission）、Amap Key 输入（保存/清空）、数据说明。
- 提醒：每 30s 检查 `mealTimeState`；进入窗口且该餐未记录且今天未提醒过（localStorage 按日期+餐次记录）→ 横条提醒态 + 若 `notify.system` 且权限 granted 则 `new Notification('到饭点啦', {body: '今天午餐推荐 …'})`；snooze 30 分钟。
- 样式：新建 `panel.css`（继续用 `--dsw-alias-*` 变量 + fallback，禁 Tailwind/外部图片）；样式注入沿用幂等 style 标签（data-plugin-css）。
- 构建：`scripts/build-client.mjs` 已支持 CSS text import；确保产物 `lib/client.js` 仍是经典脚本 + ModuleLoader 包装，可重复构建。
- smoke-client.mjs 更新：验证 ModuleLoader 协议、dock/panel 注册、api 封装（mock fetch）、提醒计算、无外部依赖。

## 10. 文件所有权（写范围，避免冲突）

| 成员 | 写范围 |
| --- | --- |
| menu-data | `data/dishes.js`、`data/recipes.js`、`data/cities.js`、`scripts/validate-data.mjs`、`tests/data/*` |
| feed-core | `src/core/*`（含新增 phase/taste/scoring/shopping/mealTime）、`tests/core/*` |
| host-store | `lib/*`、`scripts/smoke-host.mjs`、`tests/host/*` |
| butler-ui | `src/client/*`、`scripts/smoke-client.mjs`、`scripts/build-client.mjs`（如需） |
| Lead | `package.json`、`cordis.patch.yml`、`README.md`、`docs/*`、安装/验证/截图 |

## 11. 验收（Lead 最终执行）

1. `node --test "tests/core/*.test.mjs"`、`tests/data`、`tests/host` 全绿；smoke-host / smoke-client 全绿；`build-client.mjs` 可重复。
2. 安装 link 插件后：host 无 import 错误；`recommend_meal/plan_week/cook_plan/log_meal/meal_stats/find_nearby/update_profile` 出现在工具列表且可调用。
3. curl + 认证 cookie：GET/POST state、meals、plan、amap-key、nearby(无 key 路径)、shopping 均正确。
4. GUI 截图：dock 横条（饭点态）、面板 4 个 tab；交互：换一个、我吃了、附近（无 Key 提示）、自制（菜谱+清单）、设置保存→重启后仍在。
5. 记录持久化：写入 meals 后重新加载页面/重启 host，记录仍在。
