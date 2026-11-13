/**
 * 「今天吃什么」client 半 —— 样式注入（幂等）。
 *
 * 每个 CSS 文件注入为独立 <style data-plugin="dsh-today-eat" data-plugin-css="dsh-today-eat/xxx.css">；
 * 已存在同名 data-plugin-css 时直接跳过，因此插件热重载 / 重复 apply 不会重复插入。
 * 不使用 Tailwind，不引用外部资源，不引入任何新依赖。
 */

import cardCss from './card.css'
import fallbackCss from './fallback.css'
import floatCss from './float.css'
import panelCss from './panel.css'

/** 插件名，写入 data-plugin 便于定位与 HMR 清理。 */
const PLUGIN_NAME = 'dsh-today-eat'

/** 需要注入的样式表。 */
const STYLESHEETS = [
  ['dsh-today-eat/card.css', cardCss],
  ['dsh-today-eat/panel.css', panelCss],
  ['dsh-today-eat/float.css', floatCss],
  ['dsh-today-eat/fallback.css', fallbackCss],
]

/**
 * 注入一张样式表（若已存在则跳过）。
 *
 * @param {string} cssId 样式 id
 * @param {string} text CSS 文本
 * @returns {void}
 */
function ensureStylesheet(cssId, text) {
  const selector = `style[data-plugin-css="${cssId}"]`
  let existing = null
  try {
    existing = document.querySelector(selector)
  } catch {
    existing = null
  }
  if (existing !== null && existing !== undefined) return
  const style = document.createElement('style')
  style.dataset.plugin = PLUGIN_NAME
  style.dataset.pluginCss = cssId
  style.textContent = text
  document.head.appendChild(style)
}

/**
 * 确保全部样式已注入（幂等）。
 *
 * @returns {void}
 */
export function ensureStyles() {
  if (typeof document === 'undefined' || document.head === undefined) return
  for (const [cssId, text] of STYLESHEETS) ensureStylesheet(cssId, text)
}
