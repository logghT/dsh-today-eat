/**
 * 「今天吃什么」client 半 —— 面板 / 横条共用的小组件。
 *
 * 全部为纯展示 + 回调，不直接访问 store；颜色只走 CSS 类，类名在 card.css / panel.css 里定义。
 */

/**
 * 按钮。
 *
 * @param {{ variant?: 'default' | 'primary' | 'ghost' | 'danger', size?: 'sm' | 'md', className?: string, children?: unknown }} props 属性
 * @returns {object} React 元素
 */
export function Btn({ variant = 'default', size = 'md', className = '', children, ...rest }) {
  const classes = ['tde-btn', variant !== 'default' ? `tde-btn-${variant}` : '', size === 'sm' ? 'tde-btn-sm' : '', className]
    .filter((item) => item !== '')
    .join(' ')
  return (
    <button type="button" {...rest} className={classes}>
      {children}
    </button>
  )
}

/**
 * 小 chip / 标签按钮。
 *
 * @param {{ active?: boolean, title?: string, onClick?: Function, children?: unknown, className?: string }} props 属性
 * @returns {object} React 元素
 */
export function Chip({ active = false, title, onClick, children, className = '' }) {
  return (
    <button
      type="button"
      className={['tde-chip', active ? 'tde-chip-on' : '', className].filter((item) => item !== '').join(' ')}
      aria-pressed={active === true}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/**
 * 只读小标签。
 *
 * @param {{ tone?: 'brand' | 'success' | 'warn' | 'muted', children?: unknown }} props 属性
 * @returns {object} React 元素
 */
export function Tag({ tone = 'muted', children }) {
  return <span className={`tde-tag tde-tag-${tone}`}>{children}</span>
}

/**
 * 面板分区。
 *
 * @param {{ id?: string, title: string, hint?: string, extra?: unknown, children?: unknown }} props 属性
 * @returns {object} React 元素
 */
export function Section({ id, title, hint, extra, children }) {
  return (
    <section className="tde-section" id={id}>
      <header className="tde-section-head">
        <h3 className="tde-section-title">{title}</h3>
        {hint !== undefined && hint !== '' ? <span className="tde-section-hint">{hint}</span> : null}
        {extra !== undefined && extra !== null ? <span className="tde-section-extra">{extra}</span> : null}
      </header>
      {children}
    </section>
  )
}

/**
 * 空态。
 *
 * @param {{ emoji?: string, title: string, hint?: string, action?: unknown }} props 属性
 * @returns {object} React 元素
 */
export function Empty({ emoji = '🍽️', title, hint, action }) {
  return (
    <div className="tde-empty">
      <span className="tde-empty-emoji" aria-hidden="true">{emoji}</span>
      <strong className="tde-empty-title">{title}</strong>
      {hint !== undefined && hint !== '' ? <span className="tde-empty-hint">{hint}</span> : null}
      {action !== undefined && action !== null ? <div className="tde-empty-action">{action}</div> : null}
    </div>
  )
}

/**
 * 加载态。
 *
 * @param {{ text?: string }} props 属性
 * @returns {object} React 元素
 */
export function Loading({ text = '加载中…' }) {
  return (
    <div className="tde-loading" role="status">
      <span className="tde-loading-dot" aria-hidden="true" />
      <span>{text}</span>
    </div>
  )
}

/**
 * 进度条（支持目标区间带）。
 *
 * @param {{ label: string, value: number, max: number, unit?: string, band?: [number, number] | null, estimated?: boolean, hint?: string }} props 属性
 * @returns {object} React 元素
 */
export function Progress({ label, value, max, unit = '', band = null, estimated = false, hint }) {
  const safeMax = typeof max === 'number' && max > 0 ? max : 1
  const ratio = Math.max(0, Math.min(1, (typeof value === 'number' && Number.isFinite(value) ? value : 0) / safeMax))
  const bandLow = band !== null && Array.isArray(band) && band.length === 2 ? Math.max(0, Math.min(1, band[0] / safeMax)) : null
  const bandHigh = band !== null && Array.isArray(band) && band.length === 2 ? Math.max(0, Math.min(1, band[1] / safeMax)) : null
  return (
    <div className="tde-progress">
      <div className="tde-progress-head">
        <span className="tde-progress-label">{label}</span>
        <span className="tde-progress-value">
          {estimated === true ? '≈ ' : ''}
          {Math.round(typeof value === 'number' ? value : 0)}
          {unit}
          <span className="tde-progress-max"> / {Math.round(max)}{unit}</span>
        </span>
      </div>
      <div className="tde-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
        {bandLow !== null && bandHigh !== null ? (
          <span className="tde-progress-band" style={{ left: `${bandLow * 100}%`, width: `${Math.max(0, (bandHigh - bandLow) * 100)}%` }} />
        ) : null}
        <span className="tde-progress-fill" style={{ width: `${ratio * 100}%` }} />
      </div>
      {hint !== undefined && hint !== '' ? <span className="tde-progress-hint">{hint}</span> : null}
    </div>
  )
}

/**
 * 统计小卡。
 *
 * @param {{ label: string, value: string | number, unit?: string, hint?: string }} props 属性
 * @returns {object} React 元素
 */
export function Stat({ label, value, unit, hint }) {
  return (
    <div className="tde-stat">
      <span className="tde-stat-label">{label}</span>
      <span className="tde-stat-value">
        {value}
        {unit !== undefined && unit !== '' ? <span className="tde-stat-unit">{unit}</span> : null}
      </span>
      {hint !== undefined && hint !== '' ? <span className="tde-stat-hint">{hint}</span> : null}
    </div>
  )
}

/**
 * 开关。
 *
 * @param {{ checked: boolean, onChange: Function, label: string, hint?: string }} props 属性
 * @returns {object} React 元素
 */
export function Switch({ checked, onChange, label, hint }) {
  return (
    <label className="tde-switch-row">
      <span className="tde-switch-text">
        <span className="tde-switch-label">{label}</span>
        {hint !== undefined && hint !== '' ? <span className="tde-switch-hint">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        className="tde-switch"
        checked={checked === true}
        onChange={(event) => onChange(event.target.checked === true)}
      />
    </label>
  )
}

/**
 * 表单行。
 *
 * @param {{ label: string, hint?: string, children?: unknown }} props 属性
 * @returns {object} React 元素
 */
export function Field({ label, hint, children }) {
  return (
    <label className="tde-field">
      <span className="tde-field-label">{label}</span>
      <span className="tde-field-control">{children}</span>
      {hint !== undefined && hint !== '' ? <span className="tde-field-hint">{hint}</span> : null}
    </label>
  )
}

/**
 * 分段选择。
 *
 * @param {{ options: Array<{ id: string, label: string, emoji?: string }>, value: string, onChange: Function }} props 属性
 * @returns {object} React 元素
 */
export function Segmented({ options, value, onChange }) {
  return (
    <div className="tde-segmented" role="group">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={option.id === value ? 'tde-segment tde-segment-on' : 'tde-segment'}
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
        >
          {option.emoji !== undefined && option.emoji !== '' ? <span className="tde-segment-emoji" aria-hidden="true">{option.emoji}</span> : null}
          {option.label}
        </button>
      ))}
    </div>
  )
}
