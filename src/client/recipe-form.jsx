/**
 * 「添加我的菜」表单（弹层）。
 *
 * 只负责收集字段 + 调 store.addUserRecipe；持久化 / 校验在 host（lib/state.js）
 * 与 core/user-recipes.js 完成。字段尽量少：菜名 + 菜系必填，其余可留空。
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Btn } from './ui.jsx'
import { RECIPE_CUISINES } from './recipe-library.js'
import {
  USER_RECIPE_CATEGORIES,
  parseIngredientLines,
  parseStepLines,
  parseTipLines,
} from '../core/user-recipes.js'

/** 分类中文顺序（与 dish.category 一致）。 */
const CATEGORY_OPTIONS = USER_RECIPE_CATEGORIES

/**
 * 按菜系推国家（省份只对中国菜生效）。
 *
 * @param {string} cuisine 菜系
 * @returns {string} 国家
 */
function countryOfCuisine(cuisine) {
  if (cuisine === '日韩') return '日本'
  if (cuisine === '西式') return '美国'
  return '中国'
}

/**
 * 添加菜谱弹层。
 *
 * @param {{ store: object, onClose: () => void }} props 属性
 * @returns {object} React 元素
 */
export default function RecipeForm({ store, onClose }) {
  const [name, setName] = useState('')
  const [cuisine, setCuisine] = useState('云南菜')
  const [category, setCategory] = useState('家常菜')
  const [province, setProvince] = useState('')
  const [kcal, setKcal] = useState('')
  const [protein, setProtein] = useState('')
  const [difficulty, setDifficulty] = useState('易')
  const [servings, setServings] = useState('2')
  const [prepMin, setPrepMin] = useState('10')
  const [cookMin, setCookMin] = useState('15')
  const [ingredientsText, setIngredientsText] = useState('')
  const [stepsText, setStepsText] = useState('')
  const [tipsText, setTipsText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const country = countryOfCuisine(cuisine)

  /**
   * 提交表单。
   *
   * @param {object} event 提交事件
   * @returns {Promise<void>}
   */
  const submit = async (event) => {
    event.preventDefault()
    if (submitting) return
    if (name.trim() === '') {
      store.toast('先给这道菜起个名字')
      return
    }
    setSubmitting(true)
    const ingredients = parseIngredientLines(ingredientsText)
    const steps = parseStepLines(stepsText)
    const tips = parseTipLines(tipsText)
    const ok = await store.addUserRecipe({
      name: name.trim(),
      cuisine,
      category,
      country,
      province: country === '中国' ? province : '',
      difficulty,
      servings: Number(servings) || 2,
      prepMin: Number(prepMin) || 0,
      cookMin: Number(cookMin) || 0,
      kcal: Number(kcal) || 0,
      protein: Number(protein) || 0,
      ingredients,
      steps,
      tips,
    })
    setSubmitting(false)
    if (ok) onClose()
  }

  return createPortal(
    <div
      className="tde-recipe-form-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="添加我的菜"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <form className="tde-recipe-form" onSubmit={(event) => void submit(event)}>
        <header className="tde-recipe-form-head">
          <span className="tde-recipe-form-title">➕ 添加我的菜</span>
          <button type="button" className="tde-recipe-form-close" aria-label="关闭" onClick={onClose}>✕</button>
        </header>
        <p className="tde-recipe-form-hint">菜名和菜系必填，其他可留空；保存后只存在本机。</p>

        <div className="tde-recipe-form-grid">
          <label className="tde-recipe-form-field tde-recipe-form-wide">
            <span>菜名 *</span>
            <input
              className="tde-input"
              value={name}
              maxLength={40}
              required
              autoFocus
              placeholder="例如：青柠手撕鸡"
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <label className="tde-recipe-form-field">
            <span>菜系 *</span>
            <select className="tde-input" value={cuisine} onChange={(event) => setCuisine(event.target.value)}>
              {RECIPE_CUISINES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>

          <label className="tde-recipe-form-field">
            <span>分类</span>
            <select className="tde-input" value={category} onChange={(event) => setCategory(event.target.value)}>
              {CATEGORY_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>

          <label className="tde-recipe-form-field">
            <span>省份（中国菜可填）</span>
            <select
              className="tde-input"
              value={country === '中国' ? province : ''}
              disabled={country !== '中国'}
              onChange={(event) => setProvince(event.target.value)}
            >
              <option value="">不填</option>
              {['云南', '四川', '重庆', '贵州', '广西', '广东', '湖南', '湖北', '河南', '河北',
                '山东', '山西', '陕西', '甘肃', '青海', '宁夏', '新疆', '西藏', '内蒙古', '辽宁',
                '吉林', '黑龙江', '北京', '天津', '上海', '江苏', '浙江', '安徽', '福建', '江西',
                '海南', '台湾', '香港', '澳门'].map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>

          <label className="tde-recipe-form-field">
            <span>难度</span>
            <select className="tde-input" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
              <option value="易">易</option>
              <option value="中">中</option>
              <option value="难">难</option>
            </select>
          </label>

          <label className="tde-recipe-form-field">
            <span>份数</span>
            <input className="tde-input" type="number" min="1" max="20" value={servings} onChange={(event) => setServings(event.target.value)} />
          </label>

          <label className="tde-recipe-form-field">
            <span>热量 kcal（可选）</span>
            <input className="tde-input" type="number" min="0" max="3000" value={kcal} placeholder="例如 380" onChange={(event) => setKcal(event.target.value)} />
          </label>

          <label className="tde-recipe-form-field">
            <span>蛋白 g（可选）</span>
            <input className="tde-input" type="number" min="0" max="300" value={protein} placeholder="例如 30" onChange={(event) => setProtein(event.target.value)} />
          </label>

          <label className="tde-recipe-form-field">
            <span>备料分钟</span>
            <input className="tde-input" type="number" min="0" max="600" value={prepMin} onChange={(event) => setPrepMin(event.target.value)} />
          </label>

          <label className="tde-recipe-form-field">
            <span>烹饪分钟</span>
            <input className="tde-input" type="number" min="0" max="600" value={cookMin} onChange={(event) => setCookMin(event.target.value)} />
          </label>

          <label className="tde-recipe-form-field tde-recipe-form-wide">
            <span>食材（每行一个，可写「名称 数量单位」）</span>
            <textarea
              className="tde-input tde-recipe-form-textarea"
              rows={4}
              value={ingredientsText}
              placeholder={'鸡胸肉 200g\n青柠 2 个\n小米辣 2 个\n盐'}
              onChange={(event) => setIngredientsText(event.target.value)}
            />
          </label>

          <label className="tde-recipe-form-field tde-recipe-form-wide">
            <span>做法步骤（每行一步）</span>
            <textarea
              className="tde-input tde-recipe-form-textarea"
              rows={4}
              value={stepsText}
              placeholder={'鸡胸肉煮熟撕成丝。\n青柠挤汁，加小米辣、盐调成料汁。\n鸡丝和料汁拌匀即可。'}
              onChange={(event) => setStepsText(event.target.value)}
            />
          </label>

          <label className="tde-recipe-form-field tde-recipe-form-wide">
            <span>小贴士（可选，每行一条）</span>
            <textarea
              className="tde-input tde-recipe-form-textarea"
              rows={2}
              value={tipsText}
              placeholder="青柠汁最后再拌，放久会发苦。"
              onChange={(event) => setTipsText(event.target.value)}
            />
          </label>
        </div>

        <footer className="tde-recipe-form-actions">
          <Btn type="button" variant="ghost" onClick={onClose} disabled={submitting}>取消</Btn>
          <Btn type="submit" variant="primary" disabled={submitting}>{submitting ? '保存中…' : '保存到我的菜谱'}</Btn>
        </footer>
      </form>
    </div>,
    document.body,
  )
}
