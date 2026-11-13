# 菜谱去重与补位记录（2026-11-13）

## 目标

用户选择「先合并重复并补足 1000」：保留原有 500 道基线，清理并行扩容批次产生的同名重复，再补入新菜，使菜品/菜谱仍为 **1000 / 1000**，且全部可自制。

## 审计

`scripts/check-duplicates.mjs` 报告（清理前）：

- 规范化同名（去空格/标点）：**29 组、58 道**
- 同地区 **25 组**、跨地区 **4 组**
- 高度相似菜名 **91 对**
- 菜谱食材集合完全相同 **10 组**

## 处理

### 1. 合并同地区重复（删除 24 道 + 对应菜谱）

每组保留更完整/更早已在基线中的一道；原 500 道基线的 id 全部保留，未删除任何 `legacy-500` 菜品。删除的 24 个 id：

```
korean-dolsot-bibimbap
mala-xiangguo
chaoshan-beef-meatball-soup
chongqing-pea-noodle
shancheng-tangyuan
huaxi-niuroufen
yibin-ranmian
lawei-baozai-fan
chaoshan-congee
guangshi-changfen
bolo-yau
changde-beef-noodle
changsha-choudoufu
nanchang-banfen
zao-maodou
cifantuan
nanjing-yaxue-fensitang
shanxian-yangrou-tang
weifang-rouhuoshao
northeast-big-salad
huidouzi
ningxia-huixiaochi
shaxian-banmian
nanchang-waguantang
```

### 2. 同名但保留的 5 组：改为明确版本名

其中 4 组是跨地区变体，另 1 组是两条都在原 500 基线内的「杭州片儿川」；均保留，只改名避免菜谱库看起来重复：

| 原 id | 新菜名 |
| --- | --- |
| `sour-spicy-noodle` | 四川酸辣粉 |
| `sour-spicy-vermicelli` | 重庆酸辣粉 |
| `egg-pancake` | 山东鸡蛋灌饼 |
| `egg-filled-pancake` | 河南鸡蛋灌饼 |
| `gansu-jiangshui-noodle` | 甘肃浆水面 |
| `shaanxi-jiangshui-noodle` | 陕西浆水面 |
| `highland-barley-cake` | 云南青稞饼 |
| `tibetan-barley-cake` | 西藏青稞饼 |
| `pian-er-chuan` | 杭州片儿川（笋片雪菜） |
| `hangzhou-pianerchuan` | 杭州片儿川（家常版） |

### 3. 补位 24 道

新增 `data/expanded/f-dishes.js` / `f-recipes.js`，原创新菜：

腾冲稀豆粉、自贡冷吃兔、宜宾把把烧、永州血鸭、常德酱板鸭、宁波烤菜、杭州猫耳朵、陕西葫芦头泡馍、甘肃炒炮仗、宁夏羊肉臊子面、韩国部队锅、日式亲子丼、意大利千层面、台湾卤肉饭、港式咖喱鱼蛋、凯里酸汤牛肉、云南乳扇、大理生皮、川味口水鸡、重庆毛血旺、湖南剁椒蒸芋头、江西三杯鸡、潮汕卤鹅、梅州盐焗鸡。

数量：1000 − 24 + 24 = **1000**。

## 安全校验

- 原 500 道基线 id 全部保留（`data/legacy-500-ids.js` 校验）。
- 用户现有 `meals` / `plan.picks` 没有引用被删 id。
- 菜名规范化后无完全同名（新增数据测试）。
- 每个 dish 的 `recipeId` 仍能一一对应，名称/热量/蛋白一致。

## 验证结果

- `node scripts/validate-data.mjs`：✅ 菜品 1000 道（全部可自制）、菜谱 1000 道；中国 788 / 国外 212；国家 16；省级 34/34；云南菜 109 / 西南 66。
- `node scripts/check-duplicates.mjs --strict`：✅ 同名（规范化后完全相同）**0 组**；仍保留高度相似菜名 96 对（地区变体/盖饭衍生，属有意保留）与食材集合相同 8 组，详见 `docs/duplicate-audit.md`（清理前版本见 `docs/duplicate-audit-before-dedupe.md`）。
- 单测：**158/158**（core 84 / data 27 / host 47）；host 烟测 31/31；client 烟测 36/36。
- 用户当前 `meals` / `plan.picks` 未引用任何被删 id；历史记录不受影响。

## 说明

高度相似但不同名的 96 对大多是地区变体（如「白切鸡 / 湛江白切鸡」「红烧肉 / 毛氏红烧肉」），不按重复删除；如后续要更严格的“同菜多版本合并”，需要另外做内容级人工审核。

