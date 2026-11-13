/**
 * 外部菜谱参考链接（纯函数，无网络请求）。
 *
 * 说明：下厨房 / 豆果 / 美食杰等 App 均未提供公开的第三方菜谱 API，
 * 直接抓取或逆向接口会违反其服务条款且容易失效。这里只做「用户主动跳转」的
 * 搜索深链：点按钮用系统浏览器/App 打开对应搜索页，由用户自己挑选做法参考。
 *
 * @typedef {{ id: string, label: string, url: string, hint: string }} ReferenceLink
 */

/** 支持的参考站点（顺序即展示顺序）。 */
export const REFERENCE_SITES = Object.freeze([
  {
    id: 'xiachufang',
    label: '下厨房',
    hint: '菜谱与做法步骤',
    build: (keyword) => `https://www.xiachufang.com/search/?keyword=${encodeURIComponent(keyword)}`,
  },
  {
    id: 'douyin',
    label: '抖音',
    hint: '短视频做法参考',
    build: (keyword) => `https://www.douyin.com/search/${encodeURIComponent(keyword)}`,
  },
  {
    id: 'bilibili',
    label: 'B站',
    hint: '视频做法参考',
    build: (keyword) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`,
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    hint: '家常做法与经验',
    build: (keyword) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`,
  },
]);

/**
 * 生成一道菜的外部参考链接。
 *
 * @param {string} name 菜名（空名返回空数组）
 * @returns {ReferenceLink[]} 参考链接
 */
export function referenceLinksOf(name) {
  const keyword = typeof name === 'string' ? name.trim() : '';
  if (keyword === '') return [];
  return REFERENCE_SITES.map((site) => ({
    id: site.id,
    label: site.label,
    hint: site.hint,
    url: site.build(keyword),
  }));
}
