/**
 * 连锁品牌菜单知识库（点单建议用）。
 *
 * 目标：只对「网上能查到公开菜单的连锁品牌」给具体单品建议；
 * 对查不到可靠公开菜单的小店，明确让顾客到店自行看菜单点，
 * 不凭店名瞎编菜品。
 *
 * 说明：
 * - 数据是本地维护的常见公开菜单单品，不联网、不抓取；
 * - 品牌菜单会随季节/门店调整，文案统一带「以门店为准」；
 * - 健身/健康/少糖等阶段给更轻的选法，放松/放纵期按招牌点。
 */
import { PHASE_META, canonicalPhaseKind } from './phase.js'

/** 知识库覆盖的品牌数（测试/文档用）。 */
export const CHAIN_BRAND_COUNT = 35

/** 点单建议来源标签。 */
export const CHAIN_MENU_SOURCE = '品牌公开菜单'

/**
 * 阶段对应文案（兼容旧四阶段）。
 *
 * @param {string} kind 阶段
 * @returns {string} 阶段名
 */
function phaseLabel(kind) {
  const canonical = canonicalPhaseKind(kind) ?? 'performance'
  return PHASE_META[canonical]?.label ?? '训练补给'
}

/**
 * 生成一个品牌条目（冻结，避免运行时被改）。
 *
 * @param {string} brand 品牌名
 * @param {string[]} aliases 可识别别名（含品牌名本身）
 * @param {string[]} items 公开菜单常见单品
 * @param {string[]} fit 健身/健康期更推荐的搭配
 * @returns {object} 品牌条目
 */
function brand(brand, aliases, items, fit) {
  return Object.freeze({
    brand,
    aliases: Object.freeze(aliases),
    items: Object.freeze(items),
    fit: Object.freeze(fit),
  })
}

/** 常见连锁品牌（约 35 个）。 */
export const CHAIN_BRANDS = Object.freeze([
  brand('海底捞', ['海底捞'], ['捞派毛肚', '虾滑', '番茄锅', '蔬菜拼盘'], ['清汤锅', '捞派毛肚', '虾滑', '蔬菜拼盘']),
  brand('呷哺呷哺', ['呷哺呷哺', '呷哺'], ['肥牛', '蔬菜拼盘', '麻酱小料', '拉面'], ['清汤锅', '肥牛', '蔬菜拼盘']),
  brand('西贝莜面村', ['西贝莜面村', '西贝'], ['莜面鱼鱼', '牛大骨', '黄米凉糕', '羊肉串'], ['莜面鱼鱼', '牛大骨', '凉拌菜']),
  brand('老乡鸡', ['老乡鸡'], ['肥西老母鸡汤', '农家小炒肉', '蒸蛋', '杂粮饭'], ['肥西老母鸡汤', '蒸蛋', '杂粮饭', '时蔬']),
  brand('真功夫', ['真功夫'], ['香菇鸡腿饭', '香汁排骨饭', '生菜', '乌鸡汤'], ['香菇鸡腿饭', '生菜', '乌鸡汤']),
  brand('乡村基', ['乡村基'], ['功夫鸡腿饭', '铁板炒饭', '小炒肉', '时蔬'], ['功夫鸡腿饭', '时蔬']),
  brand('南城香', ['南城香'], ['虾仁馄饨', '烤串', '豆浆', '小菜'], ['虾仁馄饨', '豆浆', '小菜']),
  brand('和府捞面', ['和府捞面', '和府'], ['草本汤猪软骨面', '番茄汤面', '溏心蛋', '小菜'], ['草本汤猪软骨面', '溏心蛋', '小菜']),
  brand('李先生牛肉面', ['李先生牛肉面', '李先生'], ['牛肉面', '拌牛肉', '凉拌小菜'], ['牛肉面', '拌牛肉', '凉拌小菜']),
  brand('吉野家', ['吉野家', 'yoshinoya'], ['牛肉饭', '照烧鸡排饭', '蔬菜沙拉', '味噌汤'], ['牛肉饭小份', '蔬菜沙拉', '味噌汤']),
  brand('食其家', ['食其家', 'sukiya'], ['牛丼', '咖喱饭', '味噌汤', '沙拉'], ['牛丼小份', '沙拉', '味噌汤']),
  brand('萨莉亚', ['萨莉亚', 'saizeriya'], ['茄汁意面', '焗饭', '蒜香蜗牛', '沙拉'], ['茄汁意面', '沙拉']),
  brand('麦当劳', ['麦当劳', "mcdonald's", 'mcdonalds'], ['巨无霸', '板烧鸡腿堡', '麦香鸡', '玉米杯'], ['板烧鸡腿堡', '玉米杯', '无糖可乐']),
  brand('肯德基', ['肯德基', 'kfc'], ['吮指原味鸡', '香辣鸡腿堡', '老北京鸡肉卷', '蔬菜沙拉'], ['吮指原味鸡（去皮）', '蔬菜沙拉', '无糖茶']),
  brand('汉堡王', ['汉堡王', 'burger king', 'burgerking'], ['皇堡', '天椒皇堡', '薯条'], ['皇堡（少酱）', '无糖可乐']),
  brand('塔斯汀', ['塔斯汀'], ['香辣鸡腿中国汉堡', '藤椒鸡腿堡', '薯条'], ['香辣鸡腿中国汉堡', '无糖茶']),
  brand('华莱士', ['华莱士', 'wallace'], ['香辣鸡腿堡', '蜜汁全鸡', '薯条'], ['香辣鸡腿堡', '无糖茶']),
  brand('德克士', ['德克士', 'dicos'], ['脆皮炸鸡', '手枪腿', '咖喱饭'], ['脆皮炸鸡（去皮）', '咖喱饭']),
  brand('必胜客', ['必胜客', 'pizza hut', 'pizzahut'], ['超级至尊比萨', '意面', '沙拉'], ['意面', '沙拉']),
  brand('杨国福麻辣烫', ['杨国福麻辣烫', '杨国福'], ['自选称重', '骨汤底', '蔬菜', '豆制品'], ['骨汤底', '蔬菜', '豆制品', '少丸子']),
  brand('张亮麻辣烫', ['张亮麻辣烫', '张亮'], ['自选称重', '番茄汤底', '蔬菜'], ['番茄汤底', '蔬菜', '豆制品']),
  brand('袁记云饺', ['袁记云饺', '袁记'], ['鲜虾蟹籽云吞', '玉米鲜肉饺', '生菜'], ['鲜虾蟹籽云吞', '生菜']),
  brand('喜家德', ['喜家德'], ['虾仁水饺', '酸菜肉饺', '酱骨'], ['虾仁水饺', '凉拌菜']),
  brand('大娘水饺', ['大娘水饺', '大娘'], ['三鲜水饺', '牛杂汤'], ['三鲜水饺', '牛杂汤（少油）']),
  brand('阿香米线', ['阿香米线', '阿香'], ['过桥米线', '酸辣米线', '肥牛米线'], ['过桥米线（少油）', '蔬菜']),
  brand('蒙自源', ['蒙自源'], ['过桥米线', '酸汤米线', '小锅米线'], ['酸汤米线', '蔬菜']),
  brand('建新园', ['建新园'], ['过桥米线', '卤饵丝', '脆旺米线'], ['过桥米线', '脆旺米线']),
  brand('桥香园', ['桥香园'], ['过桥米线', '汽锅鸡', '卤菜'], ['过桥米线', '汽锅鸡']),
  brand('云海肴', ['云海肴'], ['汽锅鸡', '黑三剁', '香茅草烤鱼', '牛肝菌焖饭'], ['汽锅鸡', '黑三剁（少油）', '牛肝菌焖饭（半份）']),
  brand('太二酸菜鱼', ['太二酸菜鱼', '太二'], ['老坛子酸菜鱼', '五常米饭', '凉菜'], ['老坛子酸菜鱼', '五常米饭（半份）', '凉菜']),
  brand('鱼你在一起', ['鱼你在一起'], ['酸菜鱼', '番茄鱼', '青花椒鱼'], ['酸菜鱼', '蔬菜']),
  brand('小龙坎', ['小龙坎'], ['牛油锅', '毛肚', '鹅肠', '酥肉'], ['清汤锅', '毛肚', '蔬菜']),
  brand('新辣道鱼火锅', ['新辣道鱼火锅', '新辣道'], ['梭边鱼', '酸菜锅', '豆制品'], ['梭边鱼', '酸菜锅', '蔬菜']),
  brand('大米先生', ['大米先生'], ['自选快餐', '蒸菜', '杂粮饭'], ['蒸菜', '杂粮饭', '时蔬']),
  brand('紫燕百味鸡', ['紫燕百味鸡', '紫燕'], ['夫妻肺片', '藤椒鸡', '百味鸡'], ['藤椒鸡', '凉拌菜']),
])

/**
 * 归一化店名，便于包含匹配。
 *
 * @param {unknown} value 店名
 * @returns {string} 归一化文本
 */
function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\-_（）()【】\[\]「」·.,，。:：]/g, '')
}

/**
 * 匹配连锁品牌（长别名优先，避免「李先生」之类短词误伤）。
 *
 * @param {unknown} name 店名
 * @returns {{ brand: object, alias: string } | null} 匹配结果
 */
export function matchChainBrand(name) {
  const normalized = normalizeName(name)
  if (normalized === '') return null
  let best = null
  for (const brandEntry of CHAIN_BRANDS) {
    for (const alias of brandEntry.aliases) {
      const aliasKey = normalizeName(alias)
      if (aliasKey === '' || !normalized.includes(aliasKey)) continue
      if (best === null || aliasKey.length > best.aliasKey.length) {
        best = { brand: brandEntry, alias, aliasKey }
      }
    }
  }
  return best === null ? null : { brand: best.brand, alias: best.alias }
}

/**
 * 给一家店生成可信的点单建议。
 *
 * - 连锁品牌：给出公开菜单里的常见单品 + 阶段选法；
 * - 其他店：明确说查不到公开菜单，让顾客自行看菜单点，不编菜名。
 *
 * @param {unknown} name 店名
 * @param {string} [phaseKind] 阶段
 * @param {object} [profile] 用户档案（预留，不参与编造）
 * @returns {{ kind: 'chain' | 'unknown', brand: string | null, text: string, items: string[], fit: string[] }} 建议
 */
export function buildOrderSuggestion(name, phaseKind = 'performance', profile = {}) {
  const kind = canonicalPhaseKind(phaseKind) ?? 'performance'
  const shopName = typeof name === 'string' ? name.trim() : ''
  const matched = matchChainBrand(shopName)
  if (matched !== null) {
    const entry = matched.brand
    const itemsText = entry.items.join('、')
    const fitText = entry.fit.join('、')
    const label = phaseLabel(kind)
    let phaseText
    if (kind === 'treat') {
      phaseText = '按招牌点，配蔬菜或酸饮解腻，别硬撑。'
    } else if (kind === 'performance') {
      phaseText = `${label}优先：${fitText}；主食适量、少蘸料。`
    } else if (kind === 'low_sugar') {
      phaseText = '少糖日常：饮料选无糖，避开甜酱/糖醋，主食减半。'
    } else if (kind === 'low_sodium') {
      phaseText = '清淡少盐：少酱少腌，优先清汤/蒸煮。'
    } else if (kind === 'gentle') {
      phaseText = '养胃：选不辣、少油、好消化的，别配冰饮。'
    } else if (kind === 'high_fiber') {
      phaseText = '高纤维：加一份蔬菜/杂粮，主食换全谷。'
    } else if (kind === 'plant_based') {
      phaseText = '多吃素：优先蔬菜、豆制品，少选动物性单品。'
    } else if (kind === 'special') {
      phaseText = '特殊时期按需选：孕期避开生食/酒，银发选软烂少盐，青少年保证蛋白。'
    } else {
      phaseText = '养身体：选软烂、少油、蛋白足的，先别吃辣。'
    }
    // profile 暂不参与；保留参数方便以后按口味微调，但绝不据此编造菜品。
    void profile
    return {
      kind: 'chain',
      brand: entry.brand,
      items: [...entry.items],
      fit: [...entry.fit],
      text: `【连锁品牌·公开菜单】常见单品：${itemsText}。${phaseText}菜单可能调整，以门店为准。`,
    }
  }
  return {
    kind: 'unknown',
    brand: null,
    items: [],
    fit: [],
    text: '【查不到公开菜单】建议到店看菜单、问老板招牌菜，按自己的口味和预算点；这里不替你编推荐。',
  }
}
