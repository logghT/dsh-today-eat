# 换一个风格（style-reroll）契约

> 需求来源：用户希望「换一个」旁边多一个「换一个风格推荐」，能按菜谱大类（云南菜 / 川菜 / …）多选，之后换一个只在这些菜系里抽。
> 本文记录客户端行为与 `ui.rerollCuisines` 的数据契约；core 推荐接口不变。

## 1. 入口

三个位置共用 `src/client/style-reroll.jsx`：

| 位置 | 组件 | 按钮文案 |
| --- | --- | --- |
| 浮窗推荐卡 | `FloatCard` | 🎨 换风格 |
| 横条推荐卡 | `DockCard` | 🎨 换一个风格 |
| 面板 · 今天 | `TodayTab` 餐次横幅 | 🎨 换一个风格 |

- 按钮旁显示已选数量（`· N`）；面板/横条额外显示「风格：云南菜、川菜 ×」，`×` 一键清空。
- 点击按钮打开 portal 弹层（挂 `document.body`，避免浮窗 `overflow: hidden` 裁剪），`z-index: 10002`。
- 弹层含 11 个菜系 chip（与菜谱库 `RECIPE_CUISINES` 一致，云南菜首位）：云南菜 / 川菜 / 粤菜 / 湘菜 / 江浙 / 北方 / 西北 / 西南 / 日韩 / 西式 / 快餐。
- 底部：「未选 = 全部菜系」或「已选 N 个菜系」、清空、按风格换一个。
- 关闭：Esc、点击弹层外、滚动、窗口 resize。

## 2. 选择语义

- **未选（`[]`）= 全部菜系**，行为与旧版完全一致。
- 多选 = 取所选菜系的并集；「换一个」只在该并集里抽。
- 选择是**持久的**：写入 host `state.ui.rerollCuisines`，刷新/重启后仍生效；本机 localStorage 仅作离线兜底。
- 选择变化会清空当前 `excludeIds` 与手动选菜（`manualDishId`），让新风格立刻可见；并触发一次立即重算（不等下一餐）。
- 某个组合下没有可推荐菜时，轻提示「这个风格下暂时没有合适的菜，换几个菜系试试」，不会把界面卡在空白。

## 3. 数据契约

`ui.rerollCuisines: string[]`，默认 `[]`。

归一化规则（client `normalizeRerollCuisines` 与 host `lib/state.js` 同规则）：

1. 非数组 → `[]`；
2. 丢弃非字符串与空串；
3. 只保留 11 个合法菜系，未知值静默丢弃；
4. 去重并按固定枚举顺序（云南菜、川菜、粤菜、湘菜、江浙、北方、西北、西南、日韩、西式、快餐）排序。

示例：

```json
{ "ui": { "rerollCuisines": ["川菜", "云南菜", "川菜", "粤菜"] } }
// 归一化后：["云南菜", "川菜", "粤菜"]
```

## 4. 推荐链路

`selectRecommendation({ state, now, cuisines })`：

1. `cuisines = normalizeRerollCuisines(options.cuisines)`；
2. `catalog = filterCatalogByCuisines(CATALOG, cuisines)`（未选时原样返回）；
3. core `recommendMeal` / `getDailyPick` / `reroll` / 本地 `localPick` **全部只接收过滤后的 catalog**；
4. 备选列表来自同一结果，因此也只会是所选菜系；
5. `manualDishId` 只有在过滤后的 catalog 内存在时才生效。

core 的 `recommendMeal` 签名与打分逻辑不改；风格过滤完全在 client 层完成。

## 5. 测试

- `tests/host/state.test.mjs`：默认 `[]`、patch 归一化去重/过滤/排序、非法值清空。
- `scripts/smoke-client.mjs`：
  - `REROLL_CUISINES` 11 类、云南菜首位；
  - `normalizeRerollCuisines` 规则；
  - `filterCatalogByCuisines` 空选返回全量、单选子集；
  - `selectRecommendation` 选云南菜时主推荐/备选均为云南菜；多选川菜+湘菜时结果落在并集；
  - 弹层关键文案已打包。
- 真机验证：面板弹层 11 chip、选云南菜后换一个得到「老奶洋芋」、host 写回；浮窗 compact 弹层不被裁剪、Esc 关闭；验证后恢复 `ui`。
