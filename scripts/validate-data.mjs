#!/usr/bin/env node
/**
 * 「今天吃什么」v2 内容数据校验（零依赖，仅 node 内置模块）。
 *
 * 运行：
 *   $node scripts/validate-data.mjs      # 校验磁盘上的 data/*.js，失败 exit 1
 *
 * 校验范围见 docs/design-v2.md §4（菜品）/§5（菜谱）/§6（城市）：
 * - 数量、id 唯一、字段完整与取值范围；
 * - 菜谱与可自制菜的双向引用、营养误差 ≤10%、步骤 3-6 步、用量带数字单位、分组合法；
 * - 阶段覆盖（每个 phase ≥25 道达到 3 分以上）与阶段区分度；
 * - 城市大区合法、默认城市合法、findCity 行为。
 */
import { pathToFileURL } from 'node:url';
import { LEGACY_400_DISH_IDS } from '../data/legacy-400-ids.js';
import { LEGACY_500_DISH_IDS } from '../data/legacy-500-ids.js';
import { DISHES } from '../data/dishes.js';
import { RECIPES } from '../data/recipes.js';
import { CITIES, DEFAULT_CITY, REGIONS, findCity } from '../data/cities.js';

export const CATEGORIES = ['米饭', '面食', '汤羹', '小吃', '家常菜', '火锅烧烤', '轻食', '早餐'];
export const CUISINES = ['云南菜', '川菜', '粤菜', '湘菜', '江浙', '北方', '西北', '西南', '日韩', '西式', '快餐'];
export const SPICY_LEVELS = ['mild', 'medium', 'hot'];
export const MEAL_TAGS = ['meat', 'veg', 'seafood'];
export const STRUCTURE_TAGS = ['soup', 'noodle', 'rice', 'light'];
export const PHASES = ['fitness', 'healthy', 'relax', 'indulgence'];
export const PHASE_LABELS = { fitness: '健身', healthy: '健康', relax: '放松', indulgence: '放纵' };
export const INGREDIENT_GROUPS = ['蔬菜', '肉蛋', '水产', '豆制品', '主食', '调料', '水果'];
export const DIFFICULTIES = ['易', '中', '难'];
export const CITY_TIERS = ['一线', '新一线', '二线', '三线', '四线', '五线'];

/** country 合法枚举（docs/recipe-taxonomy.md §1；「…」允许挪威/希腊/比利时等已在库国家）。 */
export const COUNTRIES = ['中国', '日本', '韩国', '美国', '意大利', '法国', '泰国', '越南', '印度', '墨西哥', '西班牙', '英国', '土耳其', '挪威', '希腊', '比利时'];

/** 中国标准省级行政区（短名，34 个）。 */
export const PROVINCES = ['云南', '四川', '重庆', '贵州', '广西', '广东', '湖南', '湖北', '河南', '河北', '山东', '山西', '陕西', '甘肃', '青海', '宁夏', '新疆', '西藏', '内蒙古', '辽宁', '吉林', '黑龙江', '北京', '天津', '上海', '江苏', '浙江', '安徽', '福建', '江西', '海南', '台湾', '香港', '澳门'];

/** 需要覆盖的国外菜国家（每个国家 ≥2 道）。 */
export const FOREIGN_COUNTRIES = ['日本', '韩国', '泰国', '越南', '印度', '美国', '意大利', '法国', '墨西哥', '西班牙', '英国', '土耳其'];

/** 原有 v1 的 98 道菜（id 必须全部保留，只允许新增）。 */
export const LEGACY_DISH_IDS = [
  'yangzhou-fried-rice', 'huangmen-chicken-rice', 'taiwan-braised-pork-rice', 'curry-beef-rice',
  'claypot-rice', 'hainanese-chicken-rice', 'bibimbap', 'egg-fried-rice', 'tomato-beef-rice',
  'mapo-tofu-rice', 'kungpao-chicken-rice', 'eel-rice', 'seafood-fried-rice', 'lanzhou-beef-noodle',
  'chongqing-xiaomian', 'wuhan-hot-dry-noodle', 'tomato-egg-noodle', 'dalu-noodle', 'zhajiang-noodle',
  'scallion-oil-noodle', 'pian-er-chuan', 'wonton-noodle', 'tonkotsu-ramen', 'sour-spicy-noodle',
  'luosifen', 'youpo-noodle', 'xinjiang-fried-rice-noodle', 'qishan-saozi-noodle', 'dandan-noodle',
  'liangmian', 'spaghetti-bolognese', 'tomato-egg-soup', 'seaweed-egg-soup', 'hot-sour-soup',
  'winter-melon-rib-soup', 'corn-rib-soup', 'cantonese-soup', 'hulatang', 'miso-soup', 'borscht',
  'tremella-soup', 'xiaolongbao', 'shengjianbao', 'char-siu-bao', 'har-gow', 'shrimp-rice-roll',
  'potstickers', 'liangpi', 'roujiamo', 'grilled-cold-noodle', 'fried-chicken', 'french-fries',
  'takoyaki', 'stinky-tofu', 'kungpao-chicken', 'yuxiang-pork', 'mapo-tofu', 'boiled-fish',
  'twice-cooked-pork', 'chopped-pepper-fish', 'chili-fried-pork', 'sauteed-beef', 'white-cut-chicken',
  'steamed-seabass', 'garlic-broccoli', 'braised-pork', 'sweet-sour-ribs', 'disanxian', 'guobaorou',
  'dapanji', 'suancai-fish', 'laziji', 'ants-tree', 'west-lake-fish', 'hand-grabbed-lamb', 'tomato-egg',
  'sichuan-hotpot', 'tomato-hotpot', 'chaoshan-beef-hotpot', 'copper-pot-lamb', 'korean-bbq',
  'lamb-skewers', 'zibo-bbq', 'oden', 'avocado-chicken-salad', 'caesar-salad', 'salmon-quinoa-bowl',
  'chicken-wrap', 'veggie-salad', 'greek-yogurt-bowl', 'roast-chicken-bowl', 'soy-milk-youtiao',
  'century-egg-porridge', 'congee-pickles', 'jianbing', 'egg-pancake', 'steamed-dumplings',
  'oat-fruit-porridge',
];

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ADCODE_RE = /^\d{6}$/;
const CJK_RE = /[\u4e00-\u9fa5]/;

const TARGETS = { dishesMin: 1000, recipesExact: 1000, cookableExact: 1000, citiesMin: 60, yunnanSichuanFitnessMin: 30, phaseCoverMin: 25, provinceCoverMin: 30 };

/** 菜谱库 v1 的原有 60 道菜谱（必须保留，不许删减/降质）。 */
export const LEGACY_RECIPE_IDS = [
  'yunnan-papaya-chicken', 'lemon-chicken-breast', 'lemongrass-grilled-chicken', 'dai-wood-ear-salad',
  'sour-spicy-chicken-buckwheat', 'tomato-sour-fish', 'light-sour-beef', 'lime-shrimp-salad',
  'hula-chicken-breast', 'tamarind-roast-chicken', 'fitness-liangban-mixian', 'sour-spicy-konjac',
  'lemongrass-lime-fish', 'pickled-veg-chicken', 'dai-ghost-chicken', 'steam-pot-chicken',
  'baoshao-tofu', 'yunnan-red-three-chop', 'mashed-potato-yunnan', 'tofu-pudding-mixian',
  'houttuynia-salad', 'sichuan-catfish-claypot', 'cold-eat-rabbit', 'pepper-chicken-breast',
  'saliva-chicken', 'pepper-fish-slices', 'sichuan-chicken-salad', 'douban-steamed-fish',
  'garlic-pork', 'qiaojiao-beef', 'light-twice-cooked-pork', 'stir-fried-liver',
  'sour-spicy-potato', 'pan-seared-chicken', 'boiled-shrimp-veg', 'shrimp-egg-custard',
  'beef-salad-bowl', 'chicken-meatball-soup', 'whole-wheat-chicken-sandwich', 'tomato-chicken-rice',
  'broccoli-shrimp', 'pan-salmon-veg', 'oat-banana-pancake', 'tomato-egg',
  'garlic-broccoli', 'tomato-egg-soup', 'seaweed-egg-soup', 'mapo-tofu',
  'kungpao-chicken', 'yuxiang-pork', 'tomato-egg-noodle', 'scallion-oil-noodle',
  'egg-fried-rice', 'century-egg-porridge', 'congee-pickles', 'steamed-seabass',
  'white-cut-chicken', 'suancai-fish', 'hot-sour-soup', 'winter-melon-rib-soup',
];

/** 第 2 批已交付的 148 道菜/菜谱（本次扩充到 200 道，原 148 道必须全部保留）。 */
export const PREVIOUS_148_DISH_IDS = 'yangzhou-fried-rice,huangmen-chicken-rice,taiwan-braised-pork-rice,curry-beef-rice,claypot-rice,hainanese-chicken-rice,bibimbap,egg-fried-rice,tomato-beef-rice,mapo-tofu-rice,kungpao-chicken-rice,eel-rice,seafood-fried-rice,lanzhou-beef-noodle,chongqing-xiaomian,wuhan-hot-dry-noodle,tomato-egg-noodle,dalu-noodle,zhajiang-noodle,scallion-oil-noodle,pian-er-chuan,wonton-noodle,tonkotsu-ramen,sour-spicy-noodle,luosifen,youpo-noodle,xinjiang-fried-rice-noodle,qishan-saozi-noodle,dandan-noodle,liangmian,spaghetti-bolognese,tomato-egg-soup,seaweed-egg-soup,hot-sour-soup,winter-melon-rib-soup,corn-rib-soup,cantonese-soup,hulatang,miso-soup,borscht,tremella-soup,xiaolongbao,shengjianbao,char-siu-bao,har-gow,shrimp-rice-roll,potstickers,liangpi,roujiamo,grilled-cold-noodle,fried-chicken,french-fries,takoyaki,stinky-tofu,kungpao-chicken,yuxiang-pork,mapo-tofu,boiled-fish,twice-cooked-pork,chopped-pepper-fish,chili-fried-pork,sauteed-beef,white-cut-chicken,steamed-seabass,garlic-broccoli,braised-pork,sweet-sour-ribs,disanxian,guobaorou,dapanji,suancai-fish,laziji,ants-tree,west-lake-fish,hand-grabbed-lamb,tomato-egg,sichuan-hotpot,tomato-hotpot,chaoshan-beef-hotpot,copper-pot-lamb,korean-bbq,lamb-skewers,zibo-bbq,oden,avocado-chicken-salad,caesar-salad,salmon-quinoa-bowl,chicken-wrap,veggie-salad,greek-yogurt-bowl,roast-chicken-bowl,soy-milk-youtiao,century-egg-porridge,congee-pickles,jianbing,egg-pancake,steamed-dumplings,oat-fruit-porridge,yunnan-papaya-chicken,lemon-chicken-breast,lemongrass-grilled-chicken,dai-wood-ear-salad,sour-spicy-chicken-buckwheat,tomato-sour-fish,light-sour-beef,lime-shrimp-salad,hula-chicken-breast,tamarind-roast-chicken,fitness-liangban-mixian,sour-spicy-konjac,lemongrass-lime-fish,pickled-veg-chicken,dai-ghost-chicken,pineapple-rice,yunnan-pot-mixian,crossing-bridge-mixian,steam-pot-chicken,baoshao-tofu,yunnan-red-three-chop,mashed-potato-yunnan,tofu-pudding-mixian,yunnan-crispy-bun,houttuynia-salad,zhaotong-skewers,sichuan-catfish-claypot,cold-eat-rabbit,pepper-chicken-breast,saliva-chicken,pepper-fish-slices,sichuan-chicken-salad,douban-steamed-fish,dry-fried-green-beans,garlic-pork,qiaojiao-beef,light-twice-cooked-pork,stir-fried-liver,sour-spicy-potato,pan-seared-chicken,boiled-shrimp-veg,shrimp-egg-custard,beef-salad-bowl,chicken-meatball-soup,whole-wheat-chicken-sandwich,tomato-chicken-rice,broccoli-shrimp,pan-salmon-veg,oat-banana-pancake,xuanwei-ham-fried-rice'.split(',');

/** 第 3 批已交付的 200 道菜/菜谱（本次扩充到 260 道，原 200 道必须全部保留）。 */
export const PREVIOUS_200_DISH_IDS = 'yangzhou-fried-rice,huangmen-chicken-rice,taiwan-braised-pork-rice,curry-beef-rice,claypot-rice,hainanese-chicken-rice,bibimbap,egg-fried-rice,tomato-beef-rice,mapo-tofu-rice,kungpao-chicken-rice,eel-rice,seafood-fried-rice,lanzhou-beef-noodle,chongqing-xiaomian,wuhan-hot-dry-noodle,tomato-egg-noodle,dalu-noodle,zhajiang-noodle,scallion-oil-noodle,pian-er-chuan,wonton-noodle,tonkotsu-ramen,sour-spicy-noodle,luosifen,youpo-noodle,xinjiang-fried-rice-noodle,qishan-saozi-noodle,dandan-noodle,liangmian,spaghetti-bolognese,tomato-egg-soup,seaweed-egg-soup,hot-sour-soup,winter-melon-rib-soup,corn-rib-soup,cantonese-soup,hulatang,miso-soup,borscht,tremella-soup,xiaolongbao,shengjianbao,char-siu-bao,har-gow,shrimp-rice-roll,potstickers,liangpi,roujiamo,grilled-cold-noodle,fried-chicken,french-fries,takoyaki,stinky-tofu,kungpao-chicken,yuxiang-pork,mapo-tofu,boiled-fish,twice-cooked-pork,chopped-pepper-fish,chili-fried-pork,sauteed-beef,white-cut-chicken,steamed-seabass,garlic-broccoli,braised-pork,sweet-sour-ribs,disanxian,guobaorou,dapanji,suancai-fish,laziji,ants-tree,west-lake-fish,hand-grabbed-lamb,tomato-egg,sichuan-hotpot,tomato-hotpot,chaoshan-beef-hotpot,copper-pot-lamb,korean-bbq,lamb-skewers,zibo-bbq,oden,avocado-chicken-salad,caesar-salad,salmon-quinoa-bowl,chicken-wrap,veggie-salad,greek-yogurt-bowl,roast-chicken-bowl,soy-milk-youtiao,century-egg-porridge,congee-pickles,jianbing,egg-pancake,steamed-dumplings,oat-fruit-porridge,yunnan-papaya-chicken,lemon-chicken-breast,lemongrass-grilled-chicken,dai-wood-ear-salad,sour-spicy-chicken-buckwheat,tomato-sour-fish,light-sour-beef,lime-shrimp-salad,hula-chicken-breast,tamarind-roast-chicken,fitness-liangban-mixian,sour-spicy-konjac,lemongrass-lime-fish,pickled-veg-chicken,dai-ghost-chicken,pineapple-rice,yunnan-pot-mixian,crossing-bridge-mixian,steam-pot-chicken,baoshao-tofu,yunnan-red-three-chop,mashed-potato-yunnan,tofu-pudding-mixian,yunnan-crispy-bun,houttuynia-salad,zhaotong-skewers,sichuan-catfish-claypot,cold-eat-rabbit,pepper-chicken-breast,saliva-chicken,pepper-fish-slices,sichuan-chicken-salad,douban-steamed-fish,dry-fried-green-beans,garlic-pork,qiaojiao-beef,light-twice-cooked-pork,stir-fried-liver,sour-spicy-potato,pan-seared-chicken,boiled-shrimp-veg,shrimp-egg-custard,beef-salad-bowl,chicken-meatball-soup,whole-wheat-chicken-sandwich,tomato-chicken-rice,broccoli-shrimp,pan-salmon-veg,oat-banana-pancake,xuanwei-ham-fried-rice,dai-pounded-chicken-feet,yunnan-cold-chicken-mixian,tengchong-dajiujia,qujing-steamed-ers,yunnan-sour-pork-trotter,yunnan-ham-potato-rice,yunnan-mushroom-soup,yunnan-cured-pork-stirfry,sichuan-dry-pot,douhua-fish,bobo-chicken,yuxiang-eggplant,home-style-tofu,boiled-pork-slices,sichuan-liangfen,pickled-pepper-giblets,tomato-egg-rice-bowl,chicken-veggie-rice,quick-sour-beef-noodle,tomato-tofu-pot,garlic-chicken-leg-rice,teriyaki-chicken-rice,shanghai-veg-rice,one-pot-tomato-pasta,rice-cooker-sausage-rice,one-pot-tomato-beef,air-fryer-wings,air-fryer-potato-wedges,air-fryer-chicken-leg,air-fryer-salmon,air-fryer-tofu,air-fryer-ribs,pan-fried-tofu,tomato-tofu-braise,tofu-skin-salad,stir-fried-three-shreds,baby-cabbage-soup,dry-pot-cauliflower,steamed-garlic-eggplant,chive-egg,tomato-tofu-soup,radish-beef-soup,mushroom-chicken-soup,winter-melon-shrimp-soup,egg-ham-sandwich,avocado-egg-toast,tri-color-rice-ball,overnight-oats,boiled-egg-salad,red-bean-porridge,sweet-potato-egg-plate,yogurt-fruit-cup'.split(',');

/** 第 4 批已交付的 260 道菜/菜谱（本次扩充到 400 道，原 260 道必须全部保留）。 */
export const PREVIOUS_260_DISH_IDS = 'yangzhou-fried-rice,huangmen-chicken-rice,taiwan-braised-pork-rice,curry-beef-rice,claypot-rice,hainanese-chicken-rice,bibimbap,egg-fried-rice,tomato-beef-rice,mapo-tofu-rice,kungpao-chicken-rice,eel-rice,seafood-fried-rice,lanzhou-beef-noodle,chongqing-xiaomian,wuhan-hot-dry-noodle,tomato-egg-noodle,dalu-noodle,zhajiang-noodle,scallion-oil-noodle,pian-er-chuan,wonton-noodle,tonkotsu-ramen,sour-spicy-noodle,luosifen,youpo-noodle,xinjiang-fried-rice-noodle,qishan-saozi-noodle,dandan-noodle,liangmian,spaghetti-bolognese,tomato-egg-soup,seaweed-egg-soup,hot-sour-soup,winter-melon-rib-soup,corn-rib-soup,cantonese-soup,hulatang,miso-soup,borscht,tremella-soup,xiaolongbao,shengjianbao,char-siu-bao,har-gow,shrimp-rice-roll,potstickers,liangpi,roujiamo,grilled-cold-noodle,fried-chicken,french-fries,takoyaki,stinky-tofu,kungpao-chicken,yuxiang-pork,mapo-tofu,boiled-fish,twice-cooked-pork,chopped-pepper-fish,chili-fried-pork,sauteed-beef,white-cut-chicken,steamed-seabass,garlic-broccoli,braised-pork,sweet-sour-ribs,disanxian,guobaorou,dapanji,suancai-fish,laziji,ants-tree,west-lake-fish,hand-grabbed-lamb,tomato-egg,sichuan-hotpot,tomato-hotpot,chaoshan-beef-hotpot,copper-pot-lamb,korean-bbq,lamb-skewers,zibo-bbq,oden,avocado-chicken-salad,caesar-salad,salmon-quinoa-bowl,chicken-wrap,veggie-salad,greek-yogurt-bowl,roast-chicken-bowl,soy-milk-youtiao,century-egg-porridge,congee-pickles,jianbing,egg-pancake,steamed-dumplings,oat-fruit-porridge,yunnan-papaya-chicken,lemon-chicken-breast,lemongrass-grilled-chicken,dai-wood-ear-salad,sour-spicy-chicken-buckwheat,tomato-sour-fish,light-sour-beef,lime-shrimp-salad,hula-chicken-breast,tamarind-roast-chicken,fitness-liangban-mixian,sour-spicy-konjac,lemongrass-lime-fish,pickled-veg-chicken,dai-ghost-chicken,pineapple-rice,yunnan-pot-mixian,crossing-bridge-mixian,steam-pot-chicken,baoshao-tofu,yunnan-red-three-chop,mashed-potato-yunnan,tofu-pudding-mixian,yunnan-crispy-bun,houttuynia-salad,zhaotong-skewers,sichuan-catfish-claypot,cold-eat-rabbit,pepper-chicken-breast,saliva-chicken,pepper-fish-slices,sichuan-chicken-salad,douban-steamed-fish,dry-fried-green-beans,garlic-pork,qiaojiao-beef,light-twice-cooked-pork,stir-fried-liver,sour-spicy-potato,pan-seared-chicken,boiled-shrimp-veg,shrimp-egg-custard,beef-salad-bowl,chicken-meatball-soup,whole-wheat-chicken-sandwich,tomato-chicken-rice,broccoli-shrimp,pan-salmon-veg,oat-banana-pancake,xuanwei-ham-fried-rice,dai-pounded-chicken-feet,yunnan-cold-chicken-mixian,tengchong-dajiujia,qujing-steamed-ers,yunnan-sour-pork-trotter,yunnan-ham-potato-rice,yunnan-mushroom-soup,yunnan-cured-pork-stirfry,sichuan-dry-pot,douhua-fish,bobo-chicken,yuxiang-eggplant,home-style-tofu,boiled-pork-slices,sichuan-liangfen,pickled-pepper-giblets,tomato-egg-rice-bowl,chicken-veggie-rice,quick-sour-beef-noodle,tomato-tofu-pot,garlic-chicken-leg-rice,teriyaki-chicken-rice,shanghai-veg-rice,one-pot-tomato-pasta,rice-cooker-sausage-rice,one-pot-tomato-beef,air-fryer-wings,air-fryer-potato-wedges,air-fryer-chicken-leg,air-fryer-salmon,air-fryer-tofu,air-fryer-ribs,pan-fried-tofu,tomato-tofu-braise,tofu-skin-salad,stir-fried-three-shreds,baby-cabbage-soup,dry-pot-cauliflower,steamed-garlic-eggplant,chive-egg,tomato-tofu-soup,radish-beef-soup,mushroom-chicken-soup,winter-melon-shrimp-soup,egg-ham-sandwich,avocado-egg-toast,tri-color-rice-ball,overnight-oats,boiled-egg-salad,red-bean-porridge,sweet-potato-egg-plate,yogurt-fruit-cup,steamed-ribs-with-chili,grandma-veg-egg,steamed-cured-meats,dry-pot-tea-mushroom,mao-braised-pork,xiangxi-sour-fish,changsha-crayfish,pounded-chili-egg,xiangxi-pickles,hunan-beef-noodle,liuyang-steamed-egg,pickled-bean-pork,lamb-paomo,biangbiang-noodle,lanzhou-niangpi,xinjiang-pilaf,roast-naan,gansu-jiangshui-noodle,qinghai-kang-pot-lamb,shaanxi-steamed-pork,xinjiang-pepper-chicken,kimchi-soup,oyakodon,jajangmyeon,tamagoyaki,gimbap,sukiyaki,budae-jjigae,hiyayakko,teriyaki-chicken-burger,chicken-cutlet-rice,beef-burrito,hot-dog,toast-pizza,popcorn-chicken,scallion-pork-chop,yan-du-xian-soup,braised-spring-bamboo,suzhou-braised-pork-noodle,osmanthus-lotus-root,pork-vermicelli-stew,chicken-mushroom-stew,chive-pancake,northeast-mixed-stew,corn-bun,black-bean-steamed-ribs,blanched-choy-sum,beef-chow-fun,sampan-congee,pineapple-sweet-sour-pork,tomato-bisque,chicken-pasta,omelette,roasted-vegetables,cream-mushroom-soup,guizhou-spicy-chicken,yunnan-bean-rice,guangxi-lemon-duck,sichuan-cold-skewers,guizhou-sour-beef'.split(',');

/** 取字符长度（按 code point，避免 emoji / 生僻字被算成 2）。 */
function charLen(value) {
  return [...String(value)].length;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIntBetween(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function near(a, b, ratio) {
  const base = Math.max(1, Math.abs(b));
  return Math.abs(a - b) <= base * ratio + 0.001;
}

/**
 * 校验全部数据。返回 { ok, errors, summary }。
 * 允许注入数据源，便于测试复用。
 */
export function validateData({
  dishes = DISHES,
  recipes = RECIPES,
  cities = CITIES,
  regions = REGIONS,
  defaultCity = DEFAULT_CITY,
  findCityFn = findCity,
} = {}) {
  const errors = [];
  const fail = (where, message) => errors.push(`${where}：${message}`);

  if (!Array.isArray(dishes)) return { ok: false, errors: ['DISHES 不是数组'], summary: null };
  if (!Array.isArray(recipes)) return { ok: false, errors: ['RECIPES 不是数组'], summary: null };
  if (!Array.isArray(cities)) return { ok: false, errors: ['CITIES 不是数组'], summary: null };

  // ── 基础数量 ─────────────────────────────────────────
  if (dishes.length < TARGETS.dishesMin) fail('菜品数量', `应 ≥${TARGETS.dishesMin}，当前 ${dishes.length}`);
  if (recipes.length !== TARGETS.recipesExact) fail('菜谱数量', `应为 ${TARGETS.recipesExact}，当前 ${recipes.length}`);
  if (cities.length < TARGETS.citiesMin) fail('城市数量', `应 ≥${TARGETS.citiesMin}，当前 ${cities.length}`);

  // ── 菜品 ────────────────────────────────────────────
  const dishIds = new Set();
  const cookableDishIds = new Set();
  for (const dish of dishes) {
    const where = `菜品 ${dish && dish.id ? dish.id : '(缺 id)'}`;
    if (!dish || typeof dish !== 'object') {
      fail(where, '不是对象');
      continue;
    }
    if (typeof dish.id !== 'string' || !KEBAB_RE.test(dish.id)) fail(where, `id 不是 kebab-case：${dish.id}`);
    if (dishIds.has(dish.id)) fail(where, 'id 重复');
    dishIds.add(dish.id);

    if (typeof dish.name !== 'string' || charLen(dish.name) < 2 || charLen(dish.name) > 12) fail(where, 'name 缺失或长度异常');
    if (typeof dish.emoji !== 'string' || charLen(dish.emoji) < 1 || charLen(dish.emoji) > 3) fail(where, 'emoji 缺失或异常');
    if (!CATEGORIES.includes(dish.category)) fail(where, `category 非法：${dish.category}`);
    if (!CUISINES.includes(dish.cuisine)) fail(where, `cuisine 非法：${dish.cuisine}`);

    if (!Array.isArray(dish.tags) || dish.tags.length < 2) {
      fail(where, 'tags 缺失');
    } else {
      if (new Set(dish.tags).size !== dish.tags.length) fail(where, 'tags 有重复');
      const allowed = new Set([...SPICY_LEVELS, ...MEAL_TAGS, ...STRUCTURE_TAGS]);
      if (!dish.tags.every((tag) => allowed.has(tag))) fail(where, `tags 含未知值：${dish.tags.join(',')}`);
      const spicy = dish.tags.filter((tag) => SPICY_LEVELS.includes(tag));
      if (spicy.length !== 1) fail(where, `tags 必须且只能有一个辣度：${spicy.join(',') || '无'}`);
      const meal = dish.tags.filter((tag) => MEAL_TAGS.includes(tag));
      if (meal.length !== 1) fail(where, `tags 必须且只能有一个荤素标记：${meal.join(',') || '无'}`);
      const need = { 面食: 'noodle', 米饭: 'rice', 汤羹: 'soup', 轻食: 'light' }[dish.category];
      if (need && !dish.tags.includes(need)) fail(where, `${dish.category} 缺少 tag ${need}`);
    }

    if (!isFiniteNumber(dish.price) || dish.price < 10 || dish.price > 80) fail(where, `price 不在 10-80：${dish.price}`);
    if (typeof dish.description !== 'string' || !CJK_RE.test(dish.description) || /[\r\n]/.test(dish.description)) {
      fail(where, 'description 缺失或非中文');
    } else {
      const length = charLen(dish.description);
      if (length < 20 || length > 40) fail(where, `description 长度 ${length} 不在 20-40`);
    }

    if (!dish.phases || typeof dish.phases !== 'object') {
      fail(where, 'phases 缺失');
    } else {
      for (const kind of PHASES) if (!isIntBetween(dish.phases[kind], 1, 5)) fail(where, `phases.${kind} 不在 1-5：${dish.phases[kind]}`);
      const values = PHASES.map((kind) => dish.phases[kind]);
      if (Math.max(...values) < 3) fail(where, 'phases 四维全部低于 3，任何阶段都不适配');
      if (dish.phases.fitness >= 4 && dish.phases.indulgence >= 3) fail(where, 'fitness≥4 与 indulgence≥3 矛盾');
      if (new Set(values).size === 1) fail(where, 'phases 四维完全相同，缺少区分度');
    }

    if (!dish.nutrition || typeof dish.nutrition !== 'object') {
      fail(where, 'nutrition 缺失');
    } else {
      const nutrition = dish.nutrition;
      if (!isFiniteNumber(nutrition.kcal) || nutrition.kcal < 60 || nutrition.kcal > 950) fail(where, `nutrition.kcal 不合理：${nutrition.kcal}`);
      if (!isFiniteNumber(nutrition.protein) || nutrition.protein < 1 || nutrition.protein > 55) fail(where, `nutrition.protein 不合理：${nutrition.protein}`);
      if (!isFiniteNumber(nutrition.fat) || nutrition.fat < 1 || nutrition.fat > 90) fail(where, `nutrition.fat 不合理：${nutrition.fat}`);
      if (!isFiniteNumber(nutrition.carbs) || nutrition.carbs < 1 || nutrition.carbs > 115) fail(where, `nutrition.carbs 不合理：${nutrition.carbs}`);
      if (!isIntBetween(nutrition.veg, 0, 5)) fail(where, `nutrition.veg 应为 0-5 整数：${nutrition.veg}`);
      if (isFiniteNumber(nutrition.kcal) && isFiniteNumber(nutrition.protein) && isFiniteNumber(nutrition.fat) && isFiniteNumber(nutrition.carbs)) {
        const kcalFromMacros = 4 * nutrition.protein + 4 * nutrition.carbs + 9 * nutrition.fat;
        if (Math.abs(kcalFromMacros - nutrition.kcal) > nutrition.kcal * 0.35) {
          fail(where, `宏量营养素折算 ${kcalFromMacros} kcal 与 kcal ${nutrition.kcal} 偏差过大`);
        }
        // 健身高蛋白菜：蛋白 25-45g、热量克制、脂肪不超 26g。
        if (dish.phases && dish.phases.fitness >= 4 && nutrition.protein >= 25) {
          if (nutrition.protein > 45) fail(where, `健身菜蛋白 ${nutrition.protein}g 超过 45g`);
          if (nutrition.kcal < 200 || nutrition.kcal > 560) fail(where, `健身高蛋白菜热量 ${nutrition.kcal} 不在 200-560`);
          if (nutrition.fat > 26) fail(where, `健身高蛋白菜脂肪 ${nutrition.fat}g 超过 26g`);
        }
      }
    }

    if (!dish.sour || typeof dish.sour !== 'object') {
      fail(where, 'sour 缺失');
    } else {
      for (const key of ['fruit', 'fermented', 'vinegar']) {
        if (!isIntBetween(dish.sour[key], 0, 5)) fail(where, `sour.${key} 应为 0-5 整数：${dish.sour[key]}`);
      }
    }

    if (!Array.isArray(dish.origins) || dish.origins.length > 3) fail(where, 'origins 应为长度 ≤3 的数组');
    else if (!dish.origins.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 8 && !/[\|/]/.test(item))) fail(where, 'origins 含非法值（应为单个地名，不要用分隔符）');
    else if (new Set(dish.origins).size !== dish.origins.length) fail(where, 'origins 有重复');

    if (!COUNTRIES.includes(dish.country)) fail(where, `country 非法：${dish.country}`);
    if (dish.country === '中国') {
      if (!PROVINCES.includes(dish.province)) fail(where, `中国菜 province 非法或缺失：${dish.province}`);
    } else if (dish.province !== null) {
      fail(where, `国外菜 province 应为 null，当前：${dish.province}`);
    }

    if (!Array.isArray(dish.ingredients) || dish.ingredients.length < 2 || dish.ingredients.length > 8) {
      fail(where, 'ingredients 应为 2-8 项数组');
    } else {
      if (new Set(dish.ingredients).size !== dish.ingredients.length) fail(where, 'ingredients 有重复');
      if (!dish.ingredients.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 10)) fail(where, 'ingredients 含非法值');
    }

    if (typeof dish.cookable !== 'boolean') fail(where, 'cookable 应为布尔值');
    if (dish.cookable === true) {
      if (typeof dish.recipeId !== 'string' || dish.recipeId.length === 0) fail(where, 'cookable=true 但缺少 recipeId');
      else cookableDishIds.add(dish.id);
    } else if (dish.recipeId !== undefined) {
      fail(where, '不可自制菜不应带 recipeId');
    }
  }

  const missingLegacy = LEGACY_DISH_IDS.filter((id) => !dishIds.has(id));
  if (missingLegacy.length > 0) fail('旧数据兼容', `缺少原有 id：${missingLegacy.join(',')}`);

  if (PREVIOUS_148_DISH_IDS.length !== 148) fail('原 148 基线', `基线应为 148 道，当前 ${PREVIOUS_148_DISH_IDS.length}`);
  const missingPrevious148 = PREVIOUS_148_DISH_IDS.filter((id) => !dishIds.has(id));
  if (missingPrevious148.length > 0) fail('原 148 道保留', `缺少上一版菜品/菜谱 id：${missingPrevious148.join(',')}`);

  if (PREVIOUS_200_DISH_IDS.length !== 200) fail('原 200 基线', `基线应为 200 道，当前 ${PREVIOUS_200_DISH_IDS.length}`);
  const missingPrevious200 = PREVIOUS_200_DISH_IDS.filter((id) => !dishIds.has(id));
  if (missingPrevious200.length > 0) fail('原 200 道保留', `缺少上一版菜品/菜谱 id：${missingPrevious200.join(',')}`);
  const previous200Set = new Set(PREVIOUS_200_DISH_IDS);
  if (!PREVIOUS_148_DISH_IDS.every((id) => previous200Set.has(id))) fail('原 148 基线', '148 基线不是 200 基线的子集');

  if (PREVIOUS_260_DISH_IDS.length !== 260) fail('原 260 基线', `基线应为 260 道，当前 ${PREVIOUS_260_DISH_IDS.length}`);
  const missingPrevious260 = PREVIOUS_260_DISH_IDS.filter((id) => !dishIds.has(id));
  if (missingPrevious260.length > 0) fail('原 260 道保留', `缺少上一版菜品/菜谱 id：${missingPrevious260.join(',')}`);
  const previous260Set = new Set(PREVIOUS_260_DISH_IDS);
  if (!PREVIOUS_200_DISH_IDS.every((id) => previous260Set.has(id))) fail('原 200 基线', '200 基线不是 260 基线的子集');

  if (LEGACY_400_DISH_IDS.length !== 400) fail('原 400 基线', `基线应为 400 道，当前 ${LEGACY_400_DISH_IDS.length}`);
  const missingLegacy400 = LEGACY_400_DISH_IDS.filter((id) => !dishIds.has(id));
  if (missingLegacy400.length > 0) fail('原 400 道保留', `缺少上一版菜品/菜谱 id：${missingLegacy400.join(',')}`);
  const legacy400Set = new Set(LEGACY_400_DISH_IDS);
  if (!PREVIOUS_260_DISH_IDS.every((id) => legacy400Set.has(id))) fail('原 260 基线', '260 基线不是 400 基线的子集');

  if (LEGACY_500_DISH_IDS.length !== 500) fail('原 500 基线', `基线应为 500 道，当前 ${LEGACY_500_DISH_IDS.length}`);
  const missingLegacy500 = LEGACY_500_DISH_IDS.filter((id) => !dishIds.has(id));
  if (missingLegacy500.length > 0) fail('原 500 道保留', `缺少上一版菜品/菜谱 id：${missingLegacy500.join(',')}`);
  const legacy500Set = new Set(LEGACY_500_DISH_IDS);
  if (!LEGACY_400_DISH_IDS.every((id) => legacy500Set.has(id))) fail('原 400 基线', '400 基线不是 500 基线的子集');

  if (cookableDishIds.size !== TARGETS.cookableExact) {
    fail('可自制菜数量', `应为 ${TARGETS.cookableExact}，当前 ${cookableDishIds.size}`);
  }

  // 阶段覆盖：每个 phase ≥25 道达到 3 分以上
  const phaseCoverage = {};
  for (const kind of PHASES) {
    phaseCoverage[kind] = dishes.filter((dish) => dish.phases && dish.phases[kind] >= 3).length;
    if (phaseCoverage[kind] < TARGETS.phaseCoverMin) {
      fail('阶段覆盖', `${PHASE_LABELS[kind]}(${kind}) 达到 3 分以上的菜只有 ${phaseCoverage[kind]} 道，应 ≥${TARGETS.phaseCoverMin}`);
    }
  }

  // 国家 / 省份覆盖：中国省级行政区覆盖 ≥30（且每省 ≥2 道），指定国外国家各 ≥2 道
  const countryCoverage = {};
  const provinceCoverage = Object.fromEntries(PROVINCES.map((province) => [province, 0]));
  for (const dish of dishes) {
    if (!dish || typeof dish !== 'object') continue;
    countryCoverage[dish.country] = (countryCoverage[dish.country] || 0) + 1;
    if (dish.country === '中国' && PROVINCES.includes(dish.province)) provinceCoverage[dish.province] += 1;
  }
  const coveredProvinces = PROVINCES.filter((province) => provinceCoverage[province] >= 2);
  if (coveredProvinces.length < TARGETS.provinceCoverMin) {
    fail('省级覆盖', `覆盖 ≥2 道的省级行政区只有 ${coveredProvinces.length} 个，应 ≥${TARGETS.provinceCoverMin}`);
  }
  for (const country of FOREIGN_COUNTRIES) {
    if ((countryCoverage[country] || 0) < 2) fail('国家覆盖', `${country} 只有 ${countryCoverage[country] || 0} 道菜，应 ≥2`);
  }

  // 云南菜独立菜系：≥30 道且全部省份=云南；西南不再含云南省份
  const yunnanCuisineDishes = dishes.filter((dish) => dish && dish.cuisine === '云南菜');
  if (yunnanCuisineDishes.length < 30) fail('菜系覆盖', `云南菜只有 ${yunnanCuisineDishes.length} 道，应 ≥30`);
  for (const dish of yunnanCuisineDishes) {
    if (dish.province !== '云南') fail('菜系划分', `云南菜 ${dish.id} 的 province 应为云南，当前 ${dish.province}`);
  }
  const southwestDishes = dishes.filter((dish) => dish && dish.cuisine === '西南');
  if (southwestDishes.length < 3) fail('菜系覆盖', `西南菜只剩 ${southwestDishes.length} 道，应 ≥3`);
  for (const dish of southwestDishes) {
    if (dish.province === '云南') fail('菜系划分', `西南菜 ${dish.id} 不应是云南省份（云南菜已独立）`);
  }

  // ── 菜谱 ────────────────────────────────────────────
  const recipeById = new Map();
  const dishById = new Map(dishes.filter((dish) => dish && dish.id).map((dish) => [dish.id, dish]));
  for (const recipe of recipes) {
    const where = `菜谱 ${recipe && recipe.id ? recipe.id : '(缺 id)'}`;
    if (!recipe || typeof recipe !== 'object') {
      fail(where, '不是对象');
      continue;
    }
    if (typeof recipe.id !== 'string' || !KEBAB_RE.test(recipe.id)) fail(where, `id 不是 kebab-case：${recipe.id}`);
    if (recipeById.has(recipe.id)) fail(where, 'id 重复');
    recipeById.set(recipe.id, recipe);

    const dish = dishById.get(recipe.dishId);
    if (!dish) fail(where, `dishId 不存在：${recipe.dishId}`);
    else {
      if (dish.cookable !== true) fail(where, `对应菜品 ${dish.id} 不是可自制菜`);
      if (dish.recipeId !== recipe.id) fail(where, `对应菜品 recipeId(${dish.recipeId}) 未指向本菜谱`);
      if (recipe.name !== dish.name) fail(where, `name 与菜品名不一致：${recipe.name} ≠ ${dish.name}`);
      if (!near(recipe.kcal, dish.nutrition.kcal, 0.3)) fail(where, `kcal ${recipe.kcal} 与菜品 ${dish.nutrition.kcal} 误差超过 30%`);
      if (!near(recipe.protein, dish.nutrition.protein, 0.3)) fail(where, `protein ${recipe.protein} 与菜品 ${dish.nutrition.protein} 误差超过 30%`);
    }

    if (!isIntBetween(recipe.servings, 1, 4)) fail(where, `servings 应为 1-4 整数：${recipe.servings}`);
    if (!isIntBetween(recipe.prepMin, 0, 180)) fail(where, `prepMin 应为 0-180 整数：${recipe.prepMin}`);
    if (!isIntBetween(recipe.cookMin, 0, 180)) fail(where, `cookMin 应为 0-180 整数：${recipe.cookMin}`);
    if (isIntBetween(recipe.prepMin, 0, 180) && isIntBetween(recipe.cookMin, 0, 180) && recipe.prepMin + recipe.cookMin > 180) {
      fail(where, `总耗时 ${recipe.prepMin + recipe.cookMin} 分钟过长`);
    }
    if (!DIFFICULTIES.includes(recipe.difficulty)) fail(where, `difficulty 非法：${recipe.difficulty}`);

    if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length < 3 || recipe.ingredients.length > 12) {
      fail(where, 'ingredients 应为 3-12 项数组');
    } else {
      const names = new Set();
      for (const item of recipe.ingredients) {
        if (!item || typeof item !== 'object') {
          fail(where, 'ingredients 含非对象项');
          continue;
        }
        if (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 12) fail(where, `ingredients.name 非法：${item.name}`);
        if (names.has(item.name)) fail(where, `ingredients 重复：${item.name}`);
        names.add(item.name);
        if (!isFiniteNumber(item.amount) || item.amount <= 0 || item.amount > 5000) fail(where, `ingredients.${item.name} 用量非数字：${item.amount}`);
        if (typeof item.unit !== 'string' || item.unit.length === 0 || item.unit.length > 4) fail(where, `ingredients.${item.name} 单位缺失`);
        if (!INGREDIENT_GROUPS.includes(item.group)) fail(where, `ingredients.${item.name} 分组非法：${item.group}`);
      }
    }

    if (!Array.isArray(recipe.steps) || recipe.steps.length < 3 || recipe.steps.length > 6) {
      fail(where, `steps 应为 3-6 步，当前 ${Array.isArray(recipe.steps) ? recipe.steps.length : '缺失'}`);
    } else {
      for (const step of recipe.steps) {
        if (typeof step !== 'string' || charLen(step) < 8) fail(where, `步骤过短或非字符串：${step}`);
      }
    }

    if (!Array.isArray(recipe.tips) || recipe.tips.length < 1 || recipe.tips.length > 2) {
      fail(where, 'tips 应为 1-2 条');
    } else {
      for (const tip of recipe.tips) if (typeof tip !== 'string' || charLen(tip) < 4) fail(where, `tips 过短：${tip}`);
    }
  }

  for (const dishId of cookableDishIds) {
    const dish = dishById.get(dishId);
    if (!recipeById.has(dish.recipeId)) fail(`菜品 ${dishId}`, `recipeId ${dish.recipeId} 没有对应菜谱`);
  }
  if (recipeById.size !== TARGETS.recipesExact) fail('菜谱数量', `有效菜谱应为 ${TARGETS.recipesExact}，当前 ${recipeById.size}`);

  const missingLegacyRecipes = LEGACY_RECIPE_IDS.filter((id) => !recipeById.has(id));
  if (missingLegacyRecipes.length > 0) fail('旧菜谱兼容', `缺少原有菜谱 id：${missingLegacyRecipes.join(',')}`);
  if (dishes.some((dish) => dish.cookable !== true)) fail('可自制覆盖', '所有菜品都应为可自制（cookable: true）');

  const yunnanSichuanFitness = [...recipeById.values()].filter((recipe) => {
    const dish = dishById.get(recipe.dishId);
    return dish && ['云南菜', '西南', '川菜'].includes(dish.cuisine) && dish.phases && dish.phases.fitness >= 3;
  });
  if (yunnanSichuanFitness.length < TARGETS.yunnanSichuanFitnessMin) {
    fail('菜谱结构', `云南/川味健身改良菜谱只有 ${yunnanSichuanFitness.length} 道，应 ≥${TARGETS.yunnanSichuanFitnessMin}`);
  }

  // ── 城市 ────────────────────────────────────────────
  if (!Array.isArray(regions) || regions.length !== 7) fail('REGIONS', '应为 7 个大区');
  for (const region of ['西南', '华东', '华北', '华南', '华中', '西北', '东北']) {
    if (!regions.includes(region)) fail('REGIONS', `缺少大区：${region}`);
  }
  const cityNames = new Set();
  const regionCount = Object.fromEntries(regions.map((region) => [region, 0]));
  for (const city of cities) {
    const where = `城市 ${city && city.name ? city.name : '(缺 name)'}`;
    if (!city || typeof city !== 'object') {
      fail(where, '不是对象');
      continue;
    }
    if (typeof city.name !== 'string' || charLen(city.name) < 2 || charLen(city.name) > 6) fail(where, 'name 缺失或长度异常');
    if (cityNames.has(city.name)) fail(where, 'name 重复');
    cityNames.add(city.name);
    if (typeof city.province !== 'string' || city.province.length === 0) fail(where, 'province 缺失');
    if (!regions.includes(city.region)) fail(where, `region 非法：${city.region}`);
    else regionCount[city.region] += 1;
    if (typeof city.district !== 'string' || city.district.length === 0) fail(where, 'district 缺失');
    if (!isFiniteNumber(city.lat) || city.lat < 3 || city.lat > 54) fail(where, `lat 非法：${city.lat}`);
    if (!isFiniteNumber(city.lng) || city.lng < 73 || city.lng > 136) fail(where, `lng 非法：${city.lng}`);
    if (typeof city.adcode !== 'string' || !ADCODE_RE.test(city.adcode)) fail(where, `adcode 应为 6 位字符串：${city.adcode}`);
    if (!CITY_TIERS.includes(city.tier)) fail(where, `tier 非法：${city.tier}`);
    if (!Array.isArray(city.cuisines) || city.cuisines.length < 1 || city.cuisines.length > 6) fail(where, 'cuisines 应为 1-6 项数组');
    if (!Array.isArray(city.specialties) || city.specialties.length < 1 || city.specialties.length > 8) fail(where, 'specialties 应为 1-8 项数组');
  }
  for (const [region, count] of Object.entries(regionCount)) {
    if (count < 2) fail('大区覆盖', `${region} 只有 ${count} 个城市，应 ≥2`);
  }

  if (!defaultCity || !CITIES.includes(defaultCity)) fail('默认城市', '默认城市必须是 CITIES 中的一项');
  else {
    if (typeof defaultCity.province !== 'string' || defaultCity.province === '') fail('默认城市', 'province 不能为空');
    if (!REGIONS.includes(defaultCity.region)) fail('默认城市', `region 非法：${defaultCity.region}`);
    if (typeof defaultCity.district !== 'string' || defaultCity.district === '') fail('默认城市', 'district 不能为空');
    if (!isFiniteNumber(defaultCity.lat) || !isFiniteNumber(defaultCity.lng)) fail('默认城市', '经纬度必须是数字');
    if (typeof defaultCity.adcode !== 'string' || defaultCity.adcode === '') fail('默认城市', 'adcode 不能为空');
  }
  const findCityCases = [
    ['北京', DEFAULT_CITY.name], ['北京市', DEFAULT_CITY.name], [DEFAULT_CITY.district, DEFAULT_CITY.name],
    ['成都', '成都'], ['成都市的', null],
  ];
  for (const [input, expected] of findCityCases) {
    const hit = findCityFn(input);
    if (hit !== null && typeof hit !== 'object') {
      fail('findCity', `${input} 返回非对象`);
      continue;
    }
    const name = hit && hit.name;
    if (expected && name !== expected) fail('findCity', `${input} 应命中 ${expected}，实际 ${name || 'null'}`);
  }
  if (findCityFn('不存在城市') !== null) fail('findCity', '未知城市应返回 null');
  if (findCityFn('') !== null) fail('findCity', '空字符串应返回 null');
  if (findCityFn(undefined) !== null) fail('findCity', '非字符串入参应返回 null');

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      dishes: dishes.length,
      cookable: cookableDishIds.size,
      recipes: recipeById.size,
      yunnanSichuanFitnessRecipes: yunnanSichuanFitness.length,
      cities: cities.length,
      phaseCoverage,
      countryCoverage,
      provinceCoverage,
      coveredProvinces: coveredProvinces.length,
      yunnanCuisine: yunnanCuisineDishes.length,
      southwestCuisine: southwestDishes.length,
      categories: Object.fromEntries(CATEGORIES.map((category) => [category, dishes.filter((dish) => dish.category === category).length])),
      cuisines: Object.fromEntries(CUISINES.map((cuisine) => [cuisine, dishes.filter((dish) => dish.cuisine === cuisine).length])),
    },
  };
}

function main() {
  const { ok, errors, summary } = validateData();
  const lines = [];
  lines.push('「今天吃什么」v2 内容数据校验');
  lines.push(`- 菜品 ${summary.dishes} 道（可自制 ${summary.cookable}）`);
  lines.push(`- 菜谱 ${summary.recipes} 道（云南/川味健身改良 ${summary.yunnanSichuanFitnessRecipes} 道）`);
  lines.push(`- 城市 ${summary.cities} 个（大区 ${REGIONS.length} 个）`);
  lines.push(`- 国家 ${Object.keys(summary.countryCoverage).length} 个（中国 ${summary.countryCoverage['中国'] || 0} / 国外 ${summary.dishes - (summary.countryCoverage['中国'] || 0)}）`);
  lines.push(`- 中国省级行政区覆盖 ${summary.coveredProvinces}/${PROVINCES.length} 个（每省 ≥2 道）`);
  lines.push(`- 菜系：云南菜 ${summary.yunnanCuisine} 道 / 西南剩余 ${summary.southwestCuisine} 道`);
  lines.push(`- 阶段覆盖：${PHASES.map((kind) => `${PHASE_LABELS[kind]} ${summary.phaseCoverage[kind]}`).join(' / ')}`);
  lines.push(`- 分类分布：${Object.entries(summary.categories).map(([key, value]) => `${key}${value}`).join(' ')}`);
  if (!ok) {
    lines.push(`\n❌ 校验失败，共 ${errors.length} 处问题：`);
    for (const error of errors.slice(0, 80)) lines.push(`  - ${error}`);
    if (errors.length > 80) lines.push(`  …其余 ${errors.length - 80} 处省略`);
    console.error(lines.join('\n'));
    process.exitCode = 1;
    return;
  }
  lines.push('\n✅ 全部校验通过');
  console.log(lines.join('\n'));
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();
