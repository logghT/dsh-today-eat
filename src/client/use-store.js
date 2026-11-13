/**
 * 「今天吃什么」client 半 —— 订阅应用 store 的 React hook。
 *
 * 用 useSyncExternalStore（React 18 baseline）订阅；store.start() 放在 useEffect 里，
 * 与插件 apply 中的 start() 幂等，保证 dock / 面板一挂载就开始轮询与提醒。
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { getStore } from './store.js'

/**
 * 旧版 React / 烟测桩的兜底实现。
 *
 * @param {(listener: () => void) => () => void} subscribe 订阅
 * @param {() => object} getSnapshot 取快照
 * @returns {object} 快照
 */
function useStoreFallback(subscribe, getSnapshot) {
  const [snapshot, setSnapshot] = useState(getSnapshot)
  useEffect(() => subscribe(() => setSnapshot(getSnapshot())), [subscribe, getSnapshot])
  return snapshot
}

/** 优先 useSyncExternalStore。 */
const useStoreSnapshot = typeof useSyncExternalStore === 'function' ? useSyncExternalStore : useStoreFallback

/**
 * 订阅 store。
 *
 * @returns {{ store: ReturnType<typeof getStore>, snapshot: object }} store 与快照
 */
export function useAppStore() {
  const store = getStore()
  useEffect(() => {
    store.start()
  }, [store])
  const snapshot = useStoreSnapshot(store.subscribe, store.getSnapshot)
  return { store, snapshot }
}
