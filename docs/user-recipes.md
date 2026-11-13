# 我的菜谱（用户自建菜）

菜谱库右上角的「➕ 添加我的菜」允许你把常做的菜、家传做法、自己改过的版本存进插件。数据只保存在本机 `state.json`，不上传。

## 入口与交互

1. 打开面板 →「📖 菜谱」tab；
2. 点右上角「➕ 添加我的菜」；
3. 填表（**菜名 + 菜系必填**，其余可留空）：
   - 菜系：11 类（云南菜 / 川菜 / 粤菜 / 湘菜 / 江浙 / 北方 / 西北 / 西南 / 日韩 / 西式 / 快餐）；
   - 分类：米饭 / 面食 / 汤羹 / 小吃 / 家常菜 / 火锅烧烤 / 轻食 / 早餐；
   - 省份：仅中国菜可选（34 个省级行政区），日韩/西式自动归外国；
   - 热量、蛋白、备料/烹饪分钟、份数、难度：可选；
   - 食材：每行「名称 数量单位」，例如 `鸡胸肉 200g`（数量可省略，分组按关键词自动推断）；
   - 做法步骤：每行一步；小贴士：每行一条。
4. 保存后：我的菜谱排在最前，卡片带「我的」标签；顶部标题显示「1000 道 + 我的 N 道」，场景筛选中出现「我的菜谱 N」；卡片可展开看用量/步骤/参考链接；
5. 删除：展开我的菜谱卡片 → 底部「删除」→ 确认后删除（不可恢复）。

## 数据契约

`state.userRecipes` 是**对象 map**（不是数组）：

```json
{
  "userRecipes": {
    "custom-mweyfnrj-thc0s": {
      "id": "custom-mweyfnrj-thc0s",
      "name": "手撕柠檬鸡",
      "cuisine": "云南菜",
      "category": "家常菜",
      "country": "中国",
      "province": null,
      "difficulty": "易",
      "servings": 2,
      "prepMin": 10,
      "cookMin": 15,
      "kcal": 320,
      "protein": 30,
      "ingredients": [
        { "name": "鸡胸肉", "amount": 200, "unit": "g", "group": "肉蛋" }
      ],
      "steps": ["鸡胸肉煮熟，放凉撕成丝。"],
      "tips": ["青柠汁最后再拌，放久会发苦。"],
      "tags": [],
      "createdAt": 1794573008911,
      "updatedAt": 1794573008917
    }
  }
}
```

- 为什么用 map：`POST /dsh-today-eat/api/state` 的 `patch` 只接受 plain-object 根，数组会被拒绝；map 还能用 `{ [id]: null }` 表达删除。
- 新增：`patch = { userRecipes: { [id]: recipe } }`；删除：`patch = { userRecipes: { [id]: null } }`；host 归一化时过滤 `null` 与非法项。
- 校验/归一化：`src/core/user-recipes.js`（host 与 client 共用）——菜名 1–40 字、菜系必须在枚举、分类非法回退「家常菜」、国家默认中国、省份仅中国、食材最多 60、步骤最多 40、小贴士最多 20、上限 300 道；非法项直接丢弃，不会让整个 state 读失败。
- 读取：`normalizeState()` 总会把 `userRecipes` 归一化后返回；client 用 `mergeRecipeEntries(snapshot.state.userRecipes)` 合并进菜谱库条目（我的排最前），条目字段与内置菜谱一致，并带 `custom: true`。

## 限制 / 后续

- 我的菜谱目前只进「菜谱库」：可搜索、可场景/三维筛选、可展开看做法、可删除；**暂不参与推荐 / 周计划 / 采买清单**（这些仍用内置 1000 道）。
- 不支持编辑（可删除后重新添加）；不支持图片上传。
- 只在本机保存；换机器需要手动迁移 `state.json`。

## 相关文件

- 核心：`src/core/user-recipes.js`（枚举、归一化、解析、id）
- host：`lib/state.js`（`PATCH_ROOTS` / 默认值 / 归一化）
- client：`src/client/recipe-form.jsx`、`src/client/recipe-library.js`、`src/client/tabs/recipes.jsx`、`src/client/store.js`、`src/client/panel.css`
- 测试：`tests/core/user-recipes.test.mjs`、`tests/host/state.test.mjs`、`scripts/smoke-client.mjs`
