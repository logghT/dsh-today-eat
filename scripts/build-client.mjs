#!/usr/bin/env node
/**
 * 构建 client 半：把 src/client/（React 组件 + 推荐内核 + 菜品库 + CSS）
 * 打成单个经典脚本 lib/client.js，并套上 DSH 的 ModuleLoader 包装。
 *
 * 协议（与 dsh-context/lib/client.js 一致）：
 *   window.__ModuleLoader__.load({
 *     id: 'dsh-today-eat',
 *     factory: (require) => { var module = { exports: {} }; ...; return module.exports },
 *   })
 *
 * - react / react-dom / react/jsx-runtime 作为 external，运行时由 require() 提供；
 * - CSS 以 text loader 内联进 JS（组件用 ensureStyles() 注入 <style>）；
 * - 可重复执行（覆盖写 lib/client.js，不依赖已有产物）。
 *
 * 用法：node scripts/build-client.mjs
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entryFile = resolve(packageRoot, 'src/client/index.js')
const outputFile = resolve(packageRoot, 'lib/client.js')

/** 运行时 require 的 baseline 模块，不参与打包。 */
const EXTERNAL_MODULES = ['react', 'react-dom', 'react/jsx-runtime']

/** 由其他成员并行提供的可选数据文件（缺失时用空模块兜底，保证 client 可独立构建 / 烟测）。 */
const OPTIONAL_DATA_FILES = [
  {
    label: 'data/recipes.js',
    test: /data[\\/]recipes\.js$/,
    fallback: 'export const RECIPES = [];\nexport default RECIPES;\n',
  },
]

/**
 * esbuild 插件：可选数据文件缺失时提供空模块（存在时走正常解析）。
 *
 * @returns {object} esbuild 插件
 */
function optionalDataPlugin() {
  const virtualNamespace = 'tde-optional-data'
  return {
    name: 'tde-optional-data',
    setup(build) {
      for (const file of OPTIONAL_DATA_FILES) {
        build.onResolve({ filter: file.test }, (args) => {
          const absolute = resolve(args.resolveDir, args.path)
          if (existsSync(absolute)) return undefined
          console.log(`⚠ ${file.label} 尚未就绪，本次构建使用空占位（数据落地后重新构建即可自动带上）`)
          return { path: `virtual:${file.label}`, namespace: virtualNamespace }
        })
        build.onLoad({ filter: /.*/, namespace: virtualNamespace }, () => ({
          contents: file.fallback,
          loader: 'js',
        }))
      }
    },
  }
}

/**
 * 把生成的 CJS 代码缩进进 ModuleLoader factory。
 *
 * @param {string} code esbuild 产出的 CJS 代码
 * @param {string} indent 缩进字符串
 * @returns {string} 缩进后的代码
 */
function indentBlock(code, indent) {
  return code
    .split('\n')
    .map((line) => (line === '' ? '' : `${indent}${line}`))
    .join('\n')
}

/**
 * 读取 esbuild；未安装时给出明确修复指令。
 *
 * @returns {Promise<typeof import('esbuild')>} esbuild 模块
 */
async function loadEsbuild() {
  try {
    return await import('esbuild')
  } catch (error) {
    throw new Error(
      `缺少 esbuild，请先在 ${packageRoot} 执行：\n` +
        '  & $node <runtime>\\pnpm\\bin\\pnpm.mjs add -D esbuild\n' +
        `原始错误：${error && error.message ? error.message : String(error)}`,
    )
  }
}

async function main() {
  const esbuild = await loadEsbuild()
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))

  const buildResult = await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    charset: 'utf8',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    external: EXTERNAL_MODULES,
    plugins: [optionalDataPlugin()],
    legalComments: 'none',
    sourcemap: false,
    logLevel: 'warning',
  })

  if (buildResult.outputFiles === undefined || buildResult.outputFiles.length !== 1) {
    throw new Error(`esbuild 预期产出 1 个文件，实际 ${buildResult.outputFiles?.length ?? 0} 个`)
  }

  const bundled = buildResult.outputFiles[0].text
  const version = typeof packageJson.version === 'string' ? packageJson.version : '0.0.0'
  const banner = [
    '/**',
    ` * ${packageJson.name} v${version} —— client 半（经典脚本，由 scripts/build-client.mjs 生成，请勿手工编辑）`,
    ' *',
    ` * 源码：src/client/；协议：window.__ModuleLoader__.load({ id, factory })。`,
    ' * factory 返回 Cordis client 插件对象 { name, inject, apply }。',
    ' */',
  ].join('\n')

  const wrapped = `${banner}
window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageJson.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${indentBlock(bundled, '    ')}
    // ESM 默认导出在 esbuild 的 CJS 产物里位于 module.exports.default。
    return module.exports.default !== undefined ? module.exports.default : module.exports;
  },
});
`

  await mkdir(dirname(outputFile), { recursive: true })
  await writeFile(outputFile, wrapped, 'utf8')

  const sizeKb = (Buffer.byteLength(wrapped, 'utf8') / 1024).toFixed(1)
  console.log(`✔ 已生成 ${outputFile}`)
  console.log(`  包名 ${packageJson.name} · 版本 ${version} · 产物 ${sizeKb} KB`)
  console.log(`  entry src/client/index.js → format=cjs · external=${EXTERNAL_MODULES.join(',')}`)
}

main().catch((error) => {
  console.error(`✖ 构建 client 失败：${error && error.message ? error.message : String(error)}`)
  process.exitCode = 1
})
