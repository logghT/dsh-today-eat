# DSH 插件 API 笔记（为「今天吃什么」实现准备）

> 适用对象：运行中的 **DSH 0.2.2-rc.1** 桌面打包版
> 实测环境：`D:\dsh\DSH NEXT\resources\app.asar`（Electron 44.7.0 / Node 24.21.0，renderer = Web GUI `http://127.0.0.1:49396`）
> 取证方式：直接读 app.asar 内 `@deepseek-ai/*` 源码 + 已安装第三方插件源码 + 官方文档站交叉验证。
> 行为准则：**每条结论都带证据**；没验证的写「未验证/推测」。

## 0. 六个关键问题速答（先读；详细展开见后文对应章节）

> 本节针对 Lead 的 6 个具体问题，结论均已交叉验证；标注「未验证」的是我无法从源码/文档确证的部分。

**Q1 · host 半 `import "@deepseek-ai/dsh-tools"` 的解析机制 —— 已确认**

由 **DSH 安装本身**提供，不要求写进插件 `dependencies`。解析是「双锚点」：先从 dsh 安装（app.asar 内 `node_modules/@deepseek-ai/...`）解析，再从 profile 目录解析；profile 里 `pnpm-workspace.yaml` 设了 `autoInstallPeers: false`，peer 不会被装第二份（`dsh-app-boot/lib/index.js:1317` 的 profile 模块注释：「a bundle name resolves first from the dsh installation ... then from the profile directory」；`profile/pnpm-workspace.yaml`）。
做法：`engines.dsh` 必写；把 `@deepseek-ai/dsh-tools`（及用到的其它 `@deepseek-ai/dsh*`）写进 **`peerDependencies`**（共享宿主单实例）+ `devDependencies`（本地类型检查用），不要写 `dependencies`——这是官方 `develop/basic/publish.md`「通过链接安装的 checkout 保留自己的 node_modules…需要与宿主共享实例的 dsh 包同时声明在 peerDependencies 与 devDependencies 中」的原话要求，`dsh-context` 也是这么做的（其 `peerDependencies` 列了 `@deepseek-ai/dsh-session`、`@deepseek-ai/schemastery` 等）。

**Q2 · `defineTool` 的 parameters DSL / output 约定 / 工具名规范**

- `parameters` 是**隐式开放对象根**：每个 key 是一个 value schema，必填在属性上加 `required: true`；支持 `string | number | integer | boolean | null | array | object | json | oneOf`；`object` 节点**必须**显式写 `additionalProperties: true|false`；标量可加 `enum`/`const`；通用标注 `description`/`title`/`default`/`examples`（`dsh-tools/lib/index.js:9-283`；官方 `reference/subsystems/tools.md`）。
- `output` **必填** `{ schema, render }`：`schema` 用同一套 DSL（根可以是对象/数组/标量/null）；`render(args, value) => ContentBlock[]`，最常用 `[{type:"text", text: ...}]`。`execute(args, exec)` **返回与 `output.schema` 匹配的规范 JSON 值**（不是给模型看的文本），返回值不合法 → `ToolOutputError`/`INVALID_TOOL_OUTPUT`（`dsh-tools/lib/index.js:310-359,433-445`）。
- 工具名规范：`dsh-tools` 只硬校验「非空 + 全局唯一（同名重复注册报错）+ 保留名 `run_code` 不可用」（`:440`）；**没有正则**。实际约定是 snake_case 动词短语（现有工具：`todo_write`、`ask_user_question`、`web_search`、`load_workspace_dependencies`），所以 **`recommend_meal` 完全合规**。
- 补充：`presentCall(args)` / `presentResult(args, result)` 是可选的**纯函数**展示投影，返回 `card` 标签的展示意图；`exec.signal` 必须协作取消；`exec.agent?.session.append(...)` 可写会话事件（`dsh-tool-todo/lib/index.js:172-195`）。

**Q3 · `/food` 命令 —— handler 签名与 `{kind:'success', text}` 正确**

`ctx.commands.register({ name, description, input?, recordInput?, handler })`，name 不含斜杠、必须匹配 `/^[a-z][a-z0-9_-]*$/`（`dsh-commands/lib/index.js:78`）→ `"food"` 合法，用户输入 `/food`。
`handler(invocation)` 的 `invocation = { commandId, agent, rawInput, attachments, signal }`（`:379-385`）；返回值必须是 `CommandResult`：`{kind:'success', text?: string, sourceEventSeq?: number}` 或 `{kind:'error', text: string}`（**error 的 text 必须是非空字符串**，`:184-204`）。可以返回值或 `Promise`；handler 抛错会被包成 `command/done` 的 error（`:386-394`）。`commands` 需 `inject: ["commands"]`。

**Q4 · `ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({name,id,order}, Component))` —— 完全正确**

- `conversation.input.dock` 是本机真实存在的 slot：**kind=list / scope=session**，由 `dsh-client-ui-conversation` 声明（声明点 `dsh-client-ui-conversation/lib/client.js` 的 conversation.composer children；注册实例同文件 `:19942`）。list slot 的 `id` 必填、`order` 参与排序（`dsh-client-ui-slots/lib/index.js:181-186,221`）。
- `register` 内部已用 `ctx.effect` 包裹，`inject` 也是 effect 驱动，**不需要自己再包 effect，也不需要手动 dispose**（`dsh-client-ui-renderer/lib/client.js:1368,1813`）。
- **Component 可以安全使用 React hooks**：它是普通 React 函数组件，由 renderer 用 `jsx(Comp, ...)` 渲染，外面套错误边界（`dsh-client-ui-renderer/lib/client.js:736-796`）。官方组件普遍用 `useState`/`useSyncExternalStore`。注意：hooks 用法照常（不能条件调用）；entry 因 owner 声明折叠/会话切换会重挂载（session 变化会重挂载），组件本地 state 因此会重置。
- **locale 影响**：只有注册项显式写 `locale: "<namespace>"` 时组件才收到 `t(key, params)`；否则完全不受 locale 影响（`dsh-client-ui-renderer/lib/client.js:736-762` 的 `standardKit`）。写 `locale` 前必须先用 `ctx.locale.register(namespace, {zh, en, ...})` 注册字典，否则可能拿到 key 或报错（`dsh-client-ui-renderer/lib/client.js:736-762`；`dsh-client-locale/lib/client.js` 的 `locale.register`）。组件还能拿到标准 props：`sessionId`、`useSession`、`useConversation`、`useInput`、`inputActions`、`useSessions`、`useWorkspaces` 等（官方 `reference/subsystems/slots.md` 的标准 props 表）。

**Q5 · CSS 注入与主题变量（一句结论）**

在 **factory 内**（materialize 时）注入 `<style data-plugin="<包名>" data-plugin-css="<包名>/x.css">`，用 `document.querySelector('style[data-plugin-css=...]')` 去重；颜色/圆角/字体一律用 **`--dsw-alias-*` / `--dsw-radius-*` / `--dsw-font-*`** 主题变量（不要硬编码色值，自动适配明暗主题）——真实写法见 `dsh-context` 的 CSS 段，机制见 `dsh-client-modules/lib/client.js:617-631`。

**Q6 · HMR/重载后会不会重复 apply 或泄漏**

- **`apply` 会重新执行（这是预期的）**：`reload` 流程 = 拆旧 fiber（等 inertia）→ 删除该 id 的全部 `style[data-plugin]` → 重新 import bundle（factory 重新注册/执行）→ `entry.refresh()` 重新跑 `apply`（`dsh-client-modules/lib/client.js:431-505`）。
- **不会重复注册**：旧 fiber 拆掉时，所有通过 `ctx.effect` 绑定的注册（`ctx.slots.register`、`ctx.tools.register`、`ctx.commands.register`、`ctx.inject` 回调等）都会被 dispose，所以新 `apply` 不会造成 slot 重复条目（`dsh-client-ui-renderer/lib/client.js:1813`；官方 `develop/basic/index.md`「自动清理」）。
- **可能泄漏的只有你绕开 ctx 的东西**：`window.addEventListener`、`setInterval`、模块级单例、`document.body.appendChild` 等必须放进 `ctx.effect(() => { ...; return cleanup })` 或组件 `useEffect` 里；factory 闭包里的模块级缓存每次热载都会重建（不会累积，除非你写到 window/global 上）。
- **style 去重**：HMR 已自动删旧 `<style data-plugin="包名">`，所以「querySelector 去重」不是防重复注入，而是防「同一 factory 被多次执行/你自己多次注入」以及保证幂等；保持 `data-plugin-css` 守卫即可。
- 边界：release 不匹配时 HMR 帧**不应用**（需刷新页面）；bootstrap 模块（client-modules 自身）不可热替换，替换需刷新（`dsh-client-modules/lib/client.js:227-291`、`:674-677`）。

---

## 0.1 证据约定（先看这个）

本笔记中路径分三类：

| 写法 | 实际位置 |
|---|---|
| `node_modules/@deepseek-ai/xxx/lib/y.js:行号` | 相对 **`D:\dsh\DSH NEXT\resources\app.asar\`**（打包版源码，只读） |
| `profile/...` | 相对 **`<USER_HOME>\.dsh\profiles\desktop\`**（当前 desktop profile，可读写） |
| 文档 URL | `https://deepseek-harness.github.io/deepseek-harness/...`（官网在页面 URL 后加 `.md` 可拿原始 Markdown） |

复现读取 app.asar（已验证可用）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\dsh\DSH NEXT\DSH NEXT.exe' -e @"
const fs=require('fs');
console.log(fs.readFileSync('D:/dsh/DSH NEXT/resources/app.asar/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js','utf8'))
"@
```

app.asar 的 `package.json` 是**桌面壳**（`dsh-desktop-next@2.0.22-next`），不是 DSH 版本；真正的 DSH 版本看依赖：所有 `@deepseek-ai/dsh*` 均为 `0.2.2-rc.1`，`react` 为 **18.3.1**（`app.asar/package.json`）。

---

## 1. 结论速查（TL;DR）

| 问题 | 结论 |
|---|---|
| 插件必须 host+client 成对？ | **client 半必须有一个 host 半被 Loader 挂载**（扫描锚点是 host loader entry）。host 半可以只有 `apply(){}`，但不能没有。 |
| client bundle 文件格式 | **classic script**（不能用 ESM `import/export`），内容就是 `window.__ModuleLoader__.load({id, factory})`；`id` 必须等于 package name（或 `<pkg>/client`）。 |
| client 能否只用静态数据 | **能**。UI 全部可在 client 半完成，种子模块自带 react/react-dom/primitives；持久化用 `@deepseek-ai/dsh-client-store` 的 `defineStore({persist})` → localStorage。 |
| 「今天吃什么」最佳挂载点 | ① `conversation.hero.options`（新会话欢迎页卡片）② `conversation.view`（会话内独立标签页）。右侧边栏面板需额外注册 tab 类型，见 §5.7。 |
| 是否需要打包工具 | **不需要**。手写 `lib/client.js`（`React.createElement` 或 `require("react/jsx-runtime")`）即可；官方包用 rolldown/tsdown 产出同样格式。 |
| 安装方式 | `dsh plugin --profile desktop add <本地绝对路径>`（或 `link:<绝对路径>`），会写 profile `dependencies` 并自动追加到 `dsh.profile.bundles`；手写等价改动也可。 |
| 改 client.js 要不要刷新页面 | **不用**。`dsh-client-hmr` 每 500ms stat 轮询 bundle，`rebuilt` 后浏览器热替换 entry 并清理其 `<style data-plugin=...>`。改 package.json/host 代码需重启。 |
| 最容易踩的坑 | ①client bundle 用了 ESM 语法 ②`id` 与包名不一致 ③`require` 了未在 `dsh.client.inject`/`external` 声明的包 ④注册到未声明的 slot |

---

## 2. `package.json` 清单

### 2.1 三个最小 manifest（可直接抄）

**A. 只有 host 半（普通 Cordis 插件，不是 bundle）** — 官方教程 `develop/basic/index.md`

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js"
}
```

**B. bundle（带配置层，可被 profile 安装并激活）** — 官方教程 `develop/basic/publish.md`

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

**C. bundle + client 半（「今天吃什么」应使用的形态）** — 结构对齐已安装的 `dsh-context`

```json
{
  "name": "dsh-eat-today",
  "version": "0.1.0",
  "description": "今天吃什么 —— 随机决定吃什么的 DSH Web 插件",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/client.js",
    "cordis.patch.yml",
    "icon.svg",
    "README.md"
  ],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": []
    }
  },
  "engines": {
    "node": "^22.19.0 || >=24.0.0",
    "dsh": ">=0.2.2-rc.1"
  }
}
```

`cordis.patch.yml`（插件自己的挂载声明，被 profile 的 bundle 层应用）：

```yaml
# 把本包的 host 半插入配置树；dsh.client 声明让 Web 端加载 ./client bundle
- insert:
    - id: dsh-eat-today
      name: dsh-eat-today
```

证据：`profile/node_modules/dsh-context/package.json` 全文；`profile/node_modules/dsh-context/cordis.patch.yml:1-5`；`profile/node_modules/dsh-whale-widget/package.json`（只有 `dsh.bundle.patch`，没有 client 半）。

### 2.2 字段逐条

| 字段 | 是否必需 | 语义与证据 |
|---|---|---|
| `main` | 必需（client 包的 host 半入口） | Loader 按包名 import 的入口。`dsh-context` 用 `lib/index.js`；client 扫描锚点就是这个 loader entry。 |
| `type` | 建议 `module` | host 半是 ESM，由 Node loader import。客户端 bundle 不受此影响（它被当 classic script 加载）。 |
| `exports["."]` | 有 `exports` 时必需 | 否则包名解析不到入口。`dsh-context` 用 `{"types":"...","default":"./lib/index.js"}`。 |
| `exports["./client"]` | **声明 `dsh.client` 时必需** | 扫描器只认字符串或 `{default: string}` 两种；缺失直接抛错。见 `dsh-client-modules/lib/index.js:200`（`clientExportOf`）与 `:792`（`declares dsh.client but exports no "./client" bundle`）。也实现在 `dsh-context` 的 `exports["./client"]: "./lib/client.js"`。 |
| `files` | 发布 npm 时需要 | 只影响 `pnpm pack/publish`；本地 link 安装不校验。`dsh-context` 显式列出 `lib/client.js`、`cordis.patch.yml` 等。 |
| `dsh.bundle.patch` | bundle 必需 | 一个路径或**有序路径数组**；profile 依次应用这些 patch 文件。`dsh-app-boot/lib/index.js:1335`（`bundlePatchFiles`，非 string/array-of-string 抛错）、`:1317` 附近 profile 模块注释。 |
| `dsh.bundle.platforms` | 可选 | Node 平台名校验（`dsh-app-boot/lib/index.js:1065`）；非空数组且含当前平台，否则拒绝该 bundle。 |
| `dsh.bundle.listedByDefault` | 可选 | 布尔；插件市场列表默认可见性（`dsh-plugin-manager/lib/types/index.js`）。 |
| `dsh.client` | 有 client 半时必需 | 对象；`platform` 必须是非空字符串且值为 `"web"` 才会被收录（`dsh-client-modules/lib/index.js:790`）。 |
| `dsh.client.platform` | **必需** | 字符串；`"web"` 才是候选。其他值会被静默跳过（同上）。 |
| `dsh.client.inject` | 可选，字符串数组 | 包名数组：这些 client 包的 factory 必须先到达（也是 client Cordis 的 entry 依赖边）。格式错 → 启动 AggregateError（`dsh-client-modules/lib/client.js:47`、`:66`；`:791` 附近 `arriveGraphRow`）。 |
| `dsh.client.external` | 可选，字符串数组 | 你 require 的**非 baseline** 模块 specifier（可写 `<pkg>/client`）；不匹配的格式同样报错（`:67`）。官方明确「功能包不能只为绕过跨包运行时导入规则而添加 external」（`reference/subsystems/web-client.md`）。 |
| `dsh.client.immediately` | 可选，布尔 | 一阶段预取：boot 早段就加载该 bundle 脚本注册 factory（`reference/subsystems/client-modules.md` 的 `WebBootEntry.immediately`）。格式错 → 抛错（`dsh-client-modules/lib/client.js:68`）。 |
| `engines.node` | 可选 | 例子 `^22.19.0 || >=24.0.0`（`dsh-context`、`dsh-desktop-next` 均如此）。 |
| `engines.dsh` | **强烈建议** | 版本兼容的第一判据；semver 范围，`includePrerelease: true`。见 §2.6。 |
| `peerDependencies`（`@deepseek-ai/dsh*`） | 建议 | `engines.dsh` 缺失时退化为校验这些 peer 范围（`dsh-app-boot/lib/index.js:1097` `unmetRequirements`）。 |
| `dsh.compatibility.dshReleases` | 可选 | `dsh-context` 用它写 `"0.2.2-rc.1+": "compatible"`；**app-boot 不读取它**（我在 `dsh-app-boot` 里 grep 不到 `dshReleases`）——推测供插件市场/管理器展示，不作为启动校验依据。 |

### 2.3 host 半与 client 半是否必须成对

**是「必须有 host 半」，但不是「必须都实现功能」。**

- client 模块表的扫描源是 **host Loader 的 entries**：`ClientModuleRegistry` 构造时监听 `internal/plugin` 并遍历 `ctx.loader.entries()`（`dsh-client-modules/lib/index.js:602-615`、`:908-945`）；`resolveMeta` 从 entry 的模块 specifier 解析出最近 package.json，读其 `dsh.client`（`:783-803`）。
- 也就是说：**没有 host loader entry 的包，永远不会被当作 client 模块扫描**。所以 client-only 包不可行（`main` 缺失时 Loader import 也会失败）。
- 反过来：只有 host 半、没有 `dsh.client` 完全正常（例：`dsh-whale-widget` 就只声明 `dsh.bundle.patch`，它的 Web UI 走的是另一套 `webserver/index-inject` 注入路线，见 `profile/node_modules/dsh-whale-widget/lib/index.js:684-735`，**不推荐**新插件模仿）。
- 因此「今天吃什么」应写：**host 半一个空 `apply(){}`（可选加工具）+ client 半全部 UI**。
- 一个包只能有一个 live row：同名包被多个 active Loader source 解析会 composition 失败（`dsh-client-modules/lib/index.js:946-952`）。

### 2.4 插件 id 与 package name 的关系

有 4 个容易混淆的「id」，关系如下：

| 名称 | 取值 | 证据 |
|---|---|---|
| profile patch 行的 `id` | 任意稳定字符串（如 `dsh-eat-today`） | `cordis.patch.yml` 的 `- insert: [{id, name}]` |
| profile patch 行的 `name` | **模块 specifier = package name** | 同左；`dsh-plugin` 安装时按 package name 记录 bundle |
| **client 模块 id** | **package.json 的 `name`** | `resolveMeta` 用 `packageName` 建表（`dsh-client-modules/lib/index.js:786-802`）；`__ModuleLoader__.load({id})` 的 id 必须归一化后等于它（`dsh-client-modules/lib/client.js:704-716`、`:745-777`） |
| Cordis 插件 `name` 导出 | 自定义（建议与包名一致） | `dsh-context` client 导出 `name:'dsh-context'`；host 导出 `name:'dsh-context'` |

结论：**把 `__ModuleLoader__.load({id})` 的 id 写成 package name**，Cordis 插件 `name` 也保持一致，最省事。`stripClientSuffix` 允许 id 写成 `<pkg>/client`（`dsh-client-modules/lib/client.js:98-100`），但没必要。

另外两处「用包名当 key」：`plugins.bundle.config` 以 npm 包名为 key（官方 `reference/subsystems/slots.md` 明示；`dsh-context` 用 `key: Mg`，`Mg='dsh-context'`）。

### 2.5 0.2.2-rc.1 的 manifest 校验/报错条件（踩坑清单）

全部来自 `dsh-client-modules/lib/client.js` 的 `parseDshClient`（:61-75）与 `lib/index.js` 的检测逻辑：

| 条件 | 报错文本（节选） | 触发时机 |
|---|---|---|
| `dsh.client` 非对象 | `has a non-object dsh.client declaration` | 启动扫描（激活期 → AggregateError，fiber FAILED） |
| `dsh.client.platform` 非字符串 | `dsh.client.platform must be a string` | 同上 |
| `dsh.client.inject` 非字符串数组 | `dsh.client.inject must be a string array` | 同上 |
| `dsh.client.external` 非字符串数组 | `dsh.client.external must be a string array` | 同上 |
| `dsh.client.immediately` 非布尔 | `dsh.client.immediately must be a boolean` | 同上 |
| 声明了 `dsh.client` 但没有 `exports["./client"]` | `declares dsh.client but exports no "./client" bundle` | 同上 |
| `exports["./client"]` 不是 string 且没有 string `default` | `exports["./client"] must be a string or an object with a string default` | 同上 |
| `./client` 指向的文件不存在 | `client bundle not found; run \`pnpm run build\` before launch:` + package/path | 激活/重扫 |
| 同名包被多个 active Loader source 解析 | `package X resolves from multiple active Loader sources ... remove one entry` | 同上 |
| 同一个 factory 注册两次 | `duplicate factory registration for "<id>" (bundle executed twice without invalidate?)` | bundle 执行时 |
| `require("x")` 找不到 | `require("x") missed the module table — ... (a build-time externals drift, or a dynamic dependency that did not arrive)` | factory materialize 时 |
| 组装出的模块图有环 | `module graph cycle ...` | 组装 graph 时（畸形即启动失败） |

**重要缓存行为**：包元数据（含「这个包是不是 client 包」的否定结论）按 Loader specifier + baseUrl **缓存到进程重启**（`reference/subsystems/client-modules.md`「扫描」段）。因此**首次加 `dsh.client` 字段后必须重启 DSH**；重启后改 `lib/client.js` 才能靠 HMR 热载。

### 2.6 版本兼容判定（启动时真实执行的规则）

`dsh-app-boot/lib/index.js:1097`（`unmetRequirements`）：

1. 有 `engines.dsh` → 用 `semver.satisfies(runtimeVersion, engines.dsh, { includePrerelease: true })` 判；
2. 否则检查 `peerDependencies` 里名为 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的范围；
3. 不满足 → 启动/安装报不兼容；只有 **profile 的 `compatibility.json`** 里对「精确 package@version + 精确 dsh 版本」的豁免才放行（`dsh plugin allow-version` / 插件管理器授予）。

本机运行版本 = `@deepseek-ai/dsh-app-boot` 的 package version = `0.2.2-rc.1`。所以写 `"engines": { "dsh": ">=0.2.2-rc.1" }` 可通过（`dsh-context` 的写法 `">=0.2.0-rc.2 || >=0.2.1-rc.2 || >=0.2.2-rc.1"` 也通过）。

> 未验证：`engines.dsh` 里的范围是否在**安装时**也会被 `dsh plugin add` 检查（app-boot 侧是启动时；plugin-manager 有 `evaluatePluginCompatibility`，两者共用同一判定函数，推测一致）。

---

## 3. host 半形态

### 3.1 三种合法形态（官方 `develop/basic/index.md`）

```js
// ① 函数形式
export const name = "eat-today";
export function apply(ctx) {}

// ② 对象形式（推荐：一眼看清 name/inject/apply）
export default {
  name: "eat-today",
  inject: [],
  apply(ctx) {},
};

// ③ 类形式（需要对外提供服务时）
import { Service } from "@deepseek-ai/cordis";
export default class EatToday extends Service {
  static inject = [];
  constructor(ctx) { super(ctx, "eatToday"); }
}
```

实测的第三方 host 半（`dsh-context`）用的是**命名导出**：`export { Config, apply, inject, name }`（`profile/node_modules/dsh-context/lib/index.js` 末尾 `export{...yo as apply,vo as inject,_o as name}`），`name='dsh-context'`、`inject=['sessionProjections']`。三种写法 Cordis 都接受；**推荐命名导出**（便于打包器保留 export 名）。

`inject` 是**服务名数组**（不是包名）：`['tools']`、`['commands']`、`['sessionProjections']`、`['webServer']`……框架等这些 `ctx.<service>` 就绪后才调用 `apply`。

### 3.2 Config（schemastery）

导出一个 `Config`（与类型同名），Cordis 会在加载时校验并填默认值；`apply(ctx, config)` 收到已校验对象。官方 `develop/basic/config.md`：

```js
import Schema from "@deepseek-ai/schemastery";

export const name = "eat-today";
export const Config = Schema.object({
  defaultCity: Schema.string().default(""),
  allowSpicy: Schema.boolean().default(true),
});
export function apply(ctx, config) {
  // config.defaultCity / config.allowSpicy 已带默认值
}
```

真实用例：`node_modules/@deepseek-ai/dsh-tools/lib/index.js:406-409`（`static Config = z.object({...})`）、`dsh-tool-todo/lib/index.js:20`（`z.object({ allowParallelInProgress: z.boolean().required() })`）、`dsh-web-app/lib/index.js:30-35`（含 `z.transform`）。profile 里可覆盖：

```yaml
- id: dsh-eat-today
  name: dsh-eat-today
  config:
    defaultCity: 上海
```

### 3.3 注册 tool（模型可调用）

**API**：`ctx.tools.register(definition, { when? }) -> disposer`（`dsh-tools/lib/index.js:433-445`）。
`definition` 必须带 `name`、`description`、`parameters`（原始 JSON Schema）、**`output: { schema, render }`**，以及 `execute(args, exec)`。

手写 `definition` 太啰嗦，官方给的是 `defineTool()`（`dsh-tools/lib/index.js:310-359`），它做三件事：
1. 把作者侧 schema DSL 编译成受支持的 JSON Schema 子集；
2. 运行时按 schema 校验参数（失败 → `ToolArgsError`/`INVALID_ARGS`）；
3. 校验 `execute` 返回值（失败 → `ToolOutputError`/`INVALID_TOOL_OUTPUT`）。

作者侧 schema DSL 词汇（`dsh-tools/lib/index.js:9-283` + 官方 `reference/subsystems/tools.md`）：

- 类型：`string | number | integer | boolean | null | array | object | json | oneOf`
- 对象必须显式写 `additionalProperties: true | false`
- 参数根的每个属性用 `required: true` 标注必填
- 标注字段：`description`、`title`、`default`、`examples`
- 标量可加 `enum` / `const`

**可复制示例（host `lib/index.js`，可选工具）**：

```js
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "eat-today";
export const inject = ["tools"];

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "eat_today",                    // 工具名规范：snake_case，全局唯一；"run_code" 保留（dsh-tools/lib/index.js:440）
    description:
      "在给定候选菜系里为当前用户推荐一道今天吃的菜。用户说“今天吃什么”时可调用。",
    parameters: {
      candidates: {
        type: "array",
        required: true,
        description: "候选菜名列表（非空）。",
        items: { type: "string" },
      },
      spicy: { type: "boolean", description: "是否接受辣。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          pick: { type: "string", required: true },
          reason: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: `今天吃：${value.pick}（${value.reason}）` }],
    },
    execute(args, exec) {
      const pool = args.spicy === false ? args.candidates : args.candidates;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      return { pick, reason: "随机且不重样" };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "今天吃什么",
      kind: "other",
      rawInput: args.candidates,
    }),
  }));
}
```

要点：
- `execute` 返回**规范 JSON 值**（与 `output.schema` 匹配），不是字符串；模型看到的内容由 `render()` 产出。
- `exec` 是 `ToolRunContext`，含 `signal`（必须协作取消）、`agent`（可 `exec.agent.session.append(...)` 写会话事件）、`deferContext()`、`concludeTurn()`（官方 `reference/subsystems/tools.md`）。
- `presentCall` / `presentResult` 是**纯函数**（可重放），返回 `card` 标签的展示意图，UI 侧决定怎么画（`dsh-tools/lib/index.js:310-359`；`reference/subsystems/tools.md` 的展示 UI 词汇）。
- 想按 agent 作用域限制/遮蔽用 `ctx.tools.restrict({allow|deny})`、`ctx.tools.guard(fn)`（同文件 :453-468、:649-662）。

### 3.4 注册 slash command

**API**：`ctx.commands.register(definition) -> disposer`（`dsh-commands/lib/index.js:266-269`）。

校验规则（同文件 `normalizeDefinition` :149-182、`normalizeResult` :184-204）：

| 字段 | 规则 |
|---|---|
| `name` | 小写，`/^[a-z][a-z0-9_-]*$/`（:78），不含斜杠 |
| `description` | 非空字符串 |
| `input` | 可选 `{ hint: string, attachments?: boolean }` |
| `recordInput` | 可选布尔；默认 true，false 时 `command/run` 不记录原文 |
| `definitionId` | 可选，插件自有稳定 id |
| `handler(invocation)` | 必须函数；返回 `CommandResult | Promise<CommandResult>` |

```js
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands"; // 可选，仅品牌化 id

export const name = "eat-today";
export const inject = ["commands"];

export function apply(ctx) {
  ctx.commands.register({
    definitionId: CommandDefinitionId("dsh-eat-today/pick"),
    name: "eat",                      // 用户输入 /eat
    description: "随机决定今天吃什么",
    input: { hint: "可选的偏好，如：不吃辣" },
    handler({ rawInput, agent, signal }) {
      if (signal.aborted) return { kind: "error", text: "已取消" };
      const pick = "番茄牛腩饭";
      // 也可写会话事件： agent.session.append("eat-today/pick", {...})
      return { kind: "success", text: `今天吃：${pick}` };
    },
  });
}
```

`CommandResult` 只有两种：`{kind:'success', text?, sourceEventSeq?}` / `{kind:'error', text}`（`dsh-commands/lib/index.js:184-204`；官方 `reference/subsystems/commands.md`）。`invocation` 字段：`{commandId, agent, rawInput, attachments, signal}`（:379-385）。

### 3.5 storage / 持久化（host 侧）

- `ctx.storage` 是**后端注册表 + data-form 挂载点**，不是通用 KV：`mount(form, facility)` / `form(form)` / `domain`（`dsh-storage/lib/index.js:104-138`）。插件一般**不**需要它。
- 想在 host 侧落盘，第三方插件的实测做法是拿 `dshHomePath` 服务拼路径再 `node:fs` 读写（`dsh-context` host `lib/index.js` 末尾：`let n=t.get('dshHomePath'); if(typeof n=='function'){ let t=e(n('profiles', ...)); ... }`）。即：

```js
export const inject = ["dshHomePath"];      // 服务名见 @deepseek-ai/dsh-home-paths
export function apply(ctx) {
  const dir = ctx.dshHomePath("eat-today"); // 推测：签名同 dshHomePath(...segments)
  // fs.mkdirSync(dir, {recursive:true}); fs.writeFileSync(join(dir,"history.json"), ...)
}
```

> `dshHomePath` 的确切签名**未验证**（只从 dsh-context 的调用点反推）。若只需 UI 偏好/历史，走 §6.3 的 client store 更省事。

### 3.6 生命周期

`apply` 里通过 `ctx` 注册的一切（工具、命令、事件、路由、slots、effect）都绑定 Cordis fiber，卸载自动清理；需要手动清理的资源用 `ctx.effect(() => { ...; return () => cleanup() })`（官方 `develop/basic/index.md`「自动清理」）。

---

## 4. client bundle 协议

### 4.1 加载器模型（必须理解这 5 条）

来源：`dsh-client-modules/lib/client.js:1-37`（包文档注释）、`:806-853`（materialize/makeRequire）、官方 `reference/subsystems/client-modules.md`、`reference/subsystems/web-client.md`。

1. **bundle 脚本只注册 factory**：执行 `window.__ModuleLoader__.load({id, factory})` 时**不会**运行你的模块体。
2. **materialize 才执行**：第一次被 `import/require` 时运行 `factory(require)`，返回值即 module exports，并 memoize。
3. `require` 是**同步 CJS 表**：先查平台种子模块（seed），再查已 materialize 的模块，再查已注册 factory 并递归 materialize；都找不到 → **抛错**（`:842`）。
4. 动态依赖（`dsh.client.inject` / `external` 声明的包）会先被"arrive"（加载脚本注册 factory）再 materialize。
5. 模块图必须是**无环**的（factory-form CJS 无法给部分 exports，`:812`、`:781`）。

### 4.2 `factory` 的参数与返回值

```js
window.__ModuleLoader__.load({
  id: "dsh-eat-today",                 // === package.json name
  factory: (require) => {
    const React = require("react");
    const { jsx } = require("react/jsx-runtime");
    // ...模块体，可在此注入 CSS
    return { name: "eat-today", inject: ["slots"], apply(ctx) { /* ... */ } };
  },
  // chunk: "client.foo.js",           // 可选：分包。文件名必须匹配 /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/（:600、:706）
});
```

- `require` 上挂了三个额外能力（`:834-853`）：
  - `require(spec)`：同步解析（seed → 已 materialize → 已注册 factory）；
  - `require.asset(ref)`：资源 URL 解析（默认恒等；宿主 transport 可注入解析器，`dsh-web-frontend` 的 `__DSH_TRANSPORT__.resolveAsset`）；
  - `require.async(spec)`：异步 import；`"./client.xxx.js"` 形式走包内 chunk。
- **返回值**：`factory` 的返回值就是模块 exports。Cordis 插件形态支持三种（见 §3.1）；client 侧实测为 `{name, inject, apply}`（`dsh-context/lib/client.js` 末尾 `return t.exports={name:'dsh-context',inject:['slots','locale'],apply:Fg}`）。
- 官方包在 factory 内用 `var module={exports:{}}; ...; return module.exports` 包一层，只是为了 tsdown 产物形态；**你直接 `return {...}` 即可**（安装器 `:819` 直接取 factory 返回值）。

### 4.3 `require` 可用的 baseline（平台种子模块）

**权威清单**：`node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BgUyXZcc.js:196` 的 `function YZ(){return {...}}`（由 `staticModules: YZ()` 传给模块系统）：

```js
// 平台种子模块（无需声明，永远可 require）
react
react/jsx-runtime
react-dom
react-dom/client
@deepseek-ai/cordis
zod
@tanstack/react-virtual
@deepseek-ai/dsh-client-store
@deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives
@deepseek-ai/dsh-client-ui-dockkit
```

React 版本 **18.3.1**（`app.asar/package.json`），因此可用 `createRoot`/`hydrateRoot`（`dsh-client-ui-renderer/lib/client.js` 的 `mountApp` 用的就是 `react-dom/client`）。

> `@deepseek-ai/dsh-client-ui-primitives` 是**种子模块**（不是 client 行），所以 `require("@deepseek-ai/dsh-client-ui-primitives")` 不需要在 `dsh.client.inject` 里声明——这也解释了 `dsh-context` 只 require 4 个种子模块却仍能在 inject 里列一堆包（`dsh-context/lib/client.js:12`）。

### 4.4 如何 require 其它 client 包

- 只 require **种子清单**里的模块 → 什么都不用声明（推荐「今天吃什么」这样做）。
- require 其它 `@deepseek-ai/dsh-client-*` 包或第三方 client 包 → 必须让它的 factory 先到达，否则 `require` 抛 `missed the module table`：
  - 在 `dsh.client.inject: ["@deepseek-ai/dsh-client-locale", ...]` 里列包名（bare package name，`arriveGraphRow` 按此找 graph row）；
  - bundle 里出现 `<pkg>/client` 子路径 require 时，用 `dsh.client.external: ["<pkg>/client"]`（`orderByModuleGraph` 归一化去掉 `/client` 后仍能匹配行）。
- **不要**为了省事乱加 `external`：官方明确「功能包不能只为绕过跨包运行时导入规则而添加 `dsh.client.external`」（`reference/subsystems/web-client.md`）。

### 4.5 CSS 注入与主题变量

**注入方式（真实源码模式，`dsh-context/lib/client.js` 的 CSS 段，约在文件 693200 字节处）**：

```js
const cssId = "dsh-eat-today/base.css";
if (typeof document !== "undefined" &&
    document.querySelector('style[data-plugin-css=' + JSON.stringify(cssId) + ']') === null) {
  const el = document.createElement("style");
  el.dataset.plugin = "dsh-eat-today";   // → <style data-plugin="dsh-eat-today">
  el.dataset.pluginCss = cssId;          // → data-plugin-css，用于幂等/HMR 归属
  el.textContent = "...css...";
  document.head.appendChild(el);
}
```

- 加载器会**自动认领** factory 执行期间新增的未标记 `<style>` 并打上 `data-plugin=<id>`（`dsh-client-modules/lib/client.js:625-631` `claimStyles`，注释 :617-624）。
- HMR 替换 entry 时按 `style[data-plugin]` 删除旧样式（`:312-315` `removeOwnedStyles`）。所以**自己打 `data-plugin` 也可以**，官方第三方插件就是这么做的。
- **只在 factory 内注入**（materialize 时），不要在 bundle 顶层做 DOM 副作用——lazy CJS 契约（`:16-24` 注释）。

**主题变量**（`--dsw-*`，从 `dsh-client-ui-theme/lib/client.js` 与 `dsh-web-frontend/dist/assets/*.css` 统计，共 417 个去重 token，常用如下）：

| 用途 | 变量 |
|---|---|
| 主/次/三级文字 | `--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、`--dsw-alias-label-tertiary`、`--dsw-alias-label-caption` |
| 背景层 | `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1/2/3`、`--dsw-alias-bg-overlay`、`--dsw-alias-bg-mask-1` |
| 边框 | `--dsw-alias-border-l1/l2/l3/l4` |
| 交互态 | `--dsw-alias-interactive-bg-hover`、`--dsw-alias-interactive-bg-active`、`--dsw-alias-interactive-bg-hover-danger` |
| 品牌/状态 | `--dsw-alias-brand-primary`、`--dsw-alias-state-business-primary`、`--dsw-alias-state-success-primary`、`--dsw-alias-state-warn-primary`、`--dsw-alias-state-error-primary`、`--dsw-alias-state-idle-primary` |
| 链接/代码块 | `--dsw-alias-link`、`--dsw-alias-markdown-code-block`、`--dsw-alias-markdown-code-block-banner` |
| 圆角/字体/焦点 | `--dsw-radius-xs/sm/md/lg/xl/panel`、`--dsw-font-family`、`--dsw-font-xs-13`、`--dsw-focus-ring-color`、`--dsw-focus-ring-width` |
| 暗色主题钩子 | `body:not([data-ds-dark-theme]) { ... }`（`dsh-context` 用它切换明暗；另有 `body[data-ds-dark-theme]`，见 `dsh-client-ui-sidebar-right` 的 CSS） |

写法示例：`background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);`

### 4.6 最小可运行 `lib/client.js`（复制即用）

要点：**classic script**（无 `import`/`export`）、无 JSX（用 `createElement` 或 `jsx()`）、`id` = 包名、UI 注册到 `conversation.hero.options`。

```js
/**
 * dsh-eat-today · client half
 * 关键约束：
 *  1) 这是 classic script：不能有 import/export 语法；
 *  2) id 必须等于 package.json 的 name；
 *  3) 顶层只注册 factory，DOM/CSS 副作用放在 factory 内部。
 */
(function () {
  "use strict";

  var PKG = "dsh-eat-today";

  function injectCss(cssId, text) {
    if (typeof document === "undefined") return;
    if (document.querySelector('style[data-plugin-css=' + JSON.stringify(cssId) + ']') !== null) return;
    var el = document.createElement("style");
    el.setAttribute("data-plugin", PKG);
    el.setAttribute("data-plugin-css", cssId);
    el.textContent = text;
    document.head.appendChild(el);
  }

  window.__ModuleLoader__.load({
    id: PKG,
    factory: function factory(require) {
      var React = require("react");
      var jsx = require("react/jsx-runtime").jsx;

      injectCss(PKG + "/base.css", [
        ".et-card{display:flex;align-items:center;gap:12px;padding:12px 16px;",
        "border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);",
        "background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);",
        "font-family:var(--dsw-font-family);cursor:pointer;user-select:none}",
        ".et-card:hover{background:var(--dsw-alias-interactive-bg-hover)}",
        ".et-emoji{font-size:22px;line-height:1}",
        ".et-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ].join(""));

      var DISHES = [
        { name: "番茄牛腩饭", emoji: "🍅" },
        { name: "麻辣香锅", emoji: "🌶️" },
        { name: "日式咖喱", emoji: "🍛" },
        { name: "清汤牛肉面", emoji: "🍜" },
        { name: "砂锅粥", emoji: "🥣" },
      ];

      function pickDish() {
        return DISHES[Math.floor(Math.random() * DISHES.length)];
      }

      function EatCard() {
        var s = React.useState(pickDish());
        var dish = s[0], setDish = s[1];
        return jsx("div", {
          className: "et-card",
          role: "button",
          tabIndex: 0,
          title: "点击换一道",
          onClick: function () { setDish(pickDish()); },
          onKeyDown: function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDish(pickDish()); }
          },
          children: [
            jsx("span", { className: "et-emoji", children: dish.emoji }, "emoji"),
            jsx("div", {
              children: [
                jsx("div", { children: "今天吃：" + dish.name }, "name"),
                jsx("div", { className: "et-sub", children: "点一下换一道" }, "sub"),
              ],
            }, "body"),
          ],
        });
      }

      return {
        name: "eat-today",
        inject: ["slots"],
        apply: function apply(ctx) {
          // 不需要手动 effect：register/inject 内部已绑定 caller fiber（见 §5.2）
          ctx.slots.inject("conversation.hero.options", function () {
            return ctx.slots.register(
              { name: "conversation.hero.options", id: "eat-today", order: 10 },
              EatCard
            );
          });
        },
      };
    },
  });
})();
```

同时 host 半 `lib/index.js` 可以就是空插件：

```js
export const name = "eat-today";
export function apply() {}
```

> 这是**最小可用组合**：host 半只作为 Loader entry / client 扫描锚点存在。

### 4.7 要不要构建

| 方式 | 说明 |
|---|---|
| **手写 `lib/client.js`（推荐）** | 无构建链、改完存盘即 HMR；代价是不能写 JSX/TS（用 `jsx()`/`createElement`）。本机没有全局 node/pnpm，手写最省事。 |
| rolldown/tsdown 打包 | 官方与 `dsh-context` 用；产物头部就是 `window.__ModuleLoader__.load({id, factory})`（`dsh-context/lib/client.js:1-12`）。需要 node + 构建配置，非必需。 |

若坚持用打包：产物必须是 **IIFE/classic script**（`<script src>` 无 `type=module`），并且把 `react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` 等种子模块设为 external，运行时由 `require` 注入。

---

## 5. UI 挂载点（slots）

### 5.1 机制（三层）

| 层 | 归属 | 事实 |
|---|---|---|
| `SlotCore`（纯注册表） | `@deepseek-ai/dsh-client-ui-slots`（种子模块） | 声明校验、entry 账本、priority 遮蔽、dispose 级联（`dsh-client-ui-slots/lib/index.js:47-577`，`register` 在 :163，`registerFactory` 在 :74） |
| `ctx.slots` 服务（`SlotRegistry`） | `@deepseek-ai/dsh-client-ui-renderer`（client 行） | 把核心包成 Cordis Service（`dsh-client-ui-renderer/lib/client.js:1305`，`super(ctx,"slots")` :1348），提供 `register/registerFactory/inject/install/installLocale/provideRoot/snapshot/entries/...` |
| 渲染 | `ui-renderer` 的 outlet | 只有它调用 `ctx.slots.renderSlot("root")`；子 slot 通过组件的 `renderSlot` prop 渲染（官方 `reference/subsystems/slots.md`） |

**声明 → 注册**：slot 必须先被**声明**（某个 entry 在 `children` 里声明，或 `root` 内建）。向未声明 slot 注册会抛 `slot "x" is not declared`（`dsh-client-ui-slots/lib/index.js:165`）。声明/注册都随 Cordis effect 生命周期销毁（entry 卸载会递归折叠它声明的子 slot）。

**`ctx.slots.inject(key, callback)` 是扩展别人 slot 的正确姿势**：callback 在"该 slot 每段声明生命周期"内运行，owner 折叠时其 effect 被销毁、重新声明时再运行（`dsh-client-ui-renderer/lib/client.js:1368`，官方 slots.md）。

### 5.2 `ctx.slots.register(options, Component)` 选项

公开签名等价于：

```ts
register(options: {
  name: string;                    // 必须；必须已声明
  id?: string;                     // list slot 必填；也是组件 key/展示 id
  key?: string;                    // keyed slot 必填
  order?: number;                  // list 排序用（先 priority，再 order，再注册序）
  priority?: number;               // 遮蔽优先级（默认 0；越小越先/越优先渲染）
  label?: string | (() => string); // 供 owner 投影标签（如 conversation.view 的 tab 名）
  locale?: string;                  // 声明后组件收到 t(key, params)
  inject?: (sessionId?, actions?) => Props;  // 私有数据/callback/hooks
  store?: StoreHandle;             // defineStore(...) 的返回值
  children?: Record<string, SlotSpec>; // 声明子 slot（只有 owner 才需要）
  select?: (owner) => unknown;     // chain slot 必填
}, Component): () => void
```

源码：`dsh-client-ui-slots/lib/index.js:163-243`（校验：single/keyed/list/chain 的 id/key/select 要求）、`:221`（排序）、`dsh-client-ui-renderer/lib/client.js:1813-1816`（公开 `register` 用 `ctx.effect` 包一层，返回 disposer）；`inject` 的实现 :1368；`children` 声明 :191-236。

**关键：`register` 返回的 disposer 已自动绑定你的 fiber**（`register = (o,c) => this.ctx.effect(() => this._register(o,c), "slots.register()")`）。所以插件 `apply` 里直接调用即可，不需要自己再包 `ctx.effect`；`inject(key, cb)` 同理。

`children` 声明规格（`SlotSpec`）：`{ kind: 'single'|'list'|'keyed'|'chain', scope: 'root'|'session'|'session-maybe', inject?: ... }`。真实例子：`dsh-client-ui-conversation/lib/client.js:22871`（声明 `"conversation.view": { kind: "list", scope: "session" }`）、`dsh-client-ui-sidebar-right/lib/client.js:5683`（声明 `"sidebar.right.pane.tab": { kind: "keyed", scope: "session", inject: { hooks: { tabInfo } } }`）。

### 5.3 组件收到的 props（组装顺序）

`dsh-client-ui-renderer/lib/client.js:792-796`（`renderEntry`）：

```js
<Comp {...kit} {...injected} {...slotInjected.props} {...contextual} {...ownerProps} />
```

| 来源 | 内容 | 证据 |
|---|---|---|
| `kit` | 标准 scope props + `renderFactorySlot`；声明 `locale` 时加 `t`；声明 `store` 时加 `useStore`/`actions`；声明 `children` 时加 `renderSlot`（有 chain 子 slot 再加 `renderSlotChain`）；子 slot 是 session scope 时加 `SessionProvider` | `:736-762`（`standardKit`） |
| `injected` | 你的 `inject(sessionId?, actions?)` 返回值：普通字段原样透传；`hooks: {name: source}` → 组件收到 `use<Name>(selector)`；`keyedHooks` → `use<Name>(key)` | `:435-456`（`runInject` + `bindInjectSources`） |
| `slotInjected` | owner 在 child 声明里给的公共 inject（普通字段给所有人；函数成员是 hook factory） | `:167` 附近 + 官方 slots.md |
| `ownerProps` | owner 某次渲染已知的值（如 `conversation.view` 的 `inspectCall/viewRequest/openView`） | `dsh-client-ui-conversation/lib/client.js:20711` |

**标准 props**（官方 `reference/subsystems/slots.md`「框架提供的 hooks」，与源码一致）：

| 作用域 | props |
|---|---|
| 所有 scope | `useSessions`、`useSessionStatus`、`useSessionRetainInfo`、`useSessionAccess`、`useWorkspaces`、`useWorkspaceAccess`、`useRemoteAccess`、`usePanelInfo`、`useResource` |
| `session` | `sessionId`、`useSession`、`useProjection`、`useAccess`、`useConversation`、`useInput`、`inputActions`、`useChat`、`useTrajectory` |
| `session-maybe` | 同上但值可能为 undefined |
| `locale` | `t` |
| `store` | `useStore`、`actions` |

组件**永远拿不到 `ctx`**（官方 slots.md 明示）；service 与 model 留在 `apply` 闭包里，只把 callback / observable source 投影出去。

### 5.4 slot 清单（本机 0.2.2-rc.1 实测）

> 生成方式见附录 A（扫描 85 个 client bundle 的 `name: "..."` 与 `children` 声明）。共 **128 个** slot。下表为分组要点；`kind/scope` 来自声称它们的 owner。

| 分组 | 关键 slot（kind / scope） | 用途 |
|---|---|---|
| shell/layout | `shell.leading`(single/root)、`shell.bottom`(single/root)、`shell.overlay`(list/root)、`main[key=conversation]`、`main.conversation` | 全局框架：侧栏、底部、浮层 |
| conversation 外壳 | `conversation.session`(single/session)、`conversation.content`(Factory)、`conversation.composer`(chain/session)、`conversation.composer.bar` | 会话主体与输入区 |
| conversation 视图 | `conversation.view`(**list/session**)、`conversation.session.header.views.actions`(list/root) | 会话内标签页（Chat/Trajectory/第三方页） |
| 欢迎页（新会话） | `conversation.hero.options`(**list/session**)、`conversation.hero.workspace`(single/root)、`conversation.hero.workspace.directoryFlow`、`conversation.hero.agentPreset`、`conversation.hero.brand.mark` | 空会话首屏 |
| 输入区 | `conversation.input.overlay`(list/session)、`conversation.input.dock`(list/session)、`conversation.input.left/right`(list/session)、`conversation.input.attachments`、`conversation.input.model`(single/session)、`conversation.input.plan`、`conversation.input.permission`、`conversation.input.activity` | 输入框内嵌控件/弹层/挂件 |
| 会话头 | `conversation.session.header`(single/session)、`.actions`(list/session)、`.utilities`(list/session)、`.lineage`、`.corner` | 会话标题行按钮 |
| 聊天流 | `conversation.chat.flow`(single/session)、`conversation.chat.node`(**keyed**/session)、`conversation.chat.turnTail`(**list**/session)、`conversation.chat.assistant-actions`(list/session)、`conversation.chat.user.before`(chain/session)、`conversation.user.text.node`(keyed/session) | 消息渲染扩展（按 node key 替换、回合尾卡片） |
| 右侧边栏 | `rightbar.session`(single/session)、`sidebar.right.pane.tab`(**keyed**/session)、`sidebar.right.pane.tab.title`(keyed/session)、`sidebar.right.tab.guide`(chain/session)、`sidebar.right.tab.menu.item`(list/session)、`sidebar.right.tab.document*` | 右栏 tab 正文/标题/引导页 |
| 左侧栏 | `sidebar.panellist`(list/root)、`sidebar.panellist.actions`(list/root)、`sidebar.footer.action`(list/root)、`sidebar.settings`(single/root)、`sidebar.workspaces`(single/root)、`sidebar.session.row.leading/trailing/hover`(list/root)、`sidebar.brand.mark/name` | 侧栏一级面板/行内动作 |
| 设置 | `settings.section`(list/root)、`settings.general.item`(list/root)、`settings.action`(list/root)、`settings.close`、`settings.trigger`、`settings.onboarding`(list/root)、`settings.launcher`、`settings.header` | 设置页卡片 |
| 插件页 | `plugins.tab`(list/root)、`plugins.item`(list/root)、`plugins.overview`(list/root)、`plugins.bundle.config`(**keyed**/root)、`plugins.bundle.activation`(keyed/root)、`plugins.bundle.actions`(keyed/root)、`plugins.detail.section/actions/badge`(list/root)、`plugins.add.actions`(list/root) | 插件管理页（Bundle 配置卡） |
| tool 卡片 | `tool.call.toolview`(keyed/session)、`tool.call.images`(single/session)、`tool.view.cordis`(keyed/session) | 工具调用展示 |
| 其它 | `workspace.toast`(keyed/root)、`contextMenu.content/icon`(keyed/root)、`deliverables.*`、`conversation.trajectory.images`、`conversation.approval.detail`、`conversation.plan-review.actions` | 各自领域扩展 |

完整 128 条可用附录 A 脚本一键复现。官方文档也给出 Conversation 层级树（`reference/subsystems/slots.md`「Conversation 层级」），与本机扫描一致。

### 5.5 推荐挂载点 A：新会话欢迎页卡片 `conversation.hero.options`

- 类型：**list / session scope**；owner 是 `dsh-client-ui-conversation`；渲染点 `dsh-client-ui-conversation/lib/client.js:20556` 的 `renderSlot("conversation.hero.options", {})`，只在**会话已确定**（`sessionId !== undefined`）时渲染，位于 hero 工作区行末尾（新会话首屏）。
- 优点：首屏最显眼、零导航成本、`list` 可增量追加，不抢别人 cell。
- 缺点：只在新会话欢迎页出现；老会话看不到（可同时挂 `conversation.input.dock` 做常驻入口）。

```js
// 直接放进 §4.6 的 apply(ctx) 里
ctx.slots.inject("conversation.hero.options", function () {
  return ctx.slots.register(
    {
      name: "conversation.hero.options",
      id: "eat-today",       // list slot 必填
      order: 10,             // 越小越靠前
      // 可选：locale: "eat-today"（需先 ctx.locale.register(...)）
      // 可选：inject: () => ({ hooks: {...}, openTab: () => {...} })
    },
    EatCard
  );
});
```

### 5.6 推荐挂载点 B：会话内标签页 `conversation.view`

- 类型：**list / session scope**；声明在 `dsh-client-ui-conversation/lib/client.js:22871`；渲染 `renderSlot("conversation.view", ownerProps, { only: viewId })` 在 `:20711`；tab 名来自 `entry.options.label`（`resolveSlotLabel`，`:22622-22631`），缺省用 `id`。
- 这是 **`dsh-context` 同款做法**（它注册 `id=context, order=20, label:()=>t('tab.context')`，见 `profile/node_modules/dsh-context/lib/client.js` 末尾 `e.slots.inject('conversation.view', ...)`）。
- 优点：全页空间，随时可用；缺点：多一个 tab。

```js
function EatTodayView(props) {
  // props.sessionId、props.useSession 等由框架注入（session scope）
  var React = props.useState ? null : null; // 占位，实际见下（React 从 factory 闭包拿）
}

ctx.slots.inject("conversation.view", function () {
  return ctx.slots.register(
    {
      name: "conversation.view",
      id: "eat-today",
      order: 100,
      label: function () { return "今天吃什么"; },   // 出现 tab 名
      // children 由 owner（ui-conversation）声明，这里不需要
    },
    function EatTodayView(props) {
      var st = React.useState(pickDish());
      var dish = st[0], setDish = st[1];
      return jsx("div", {
        style: { padding: "24px", color: "var(--dsw-alias-label-primary)" },
        children: [
          jsx("h2", { children: "今天吃什么" }, "h"),
          jsx("div", { className: "et-emoji", children: dish.emoji }, "e"),
          jsx("div", { children: dish.name }, "n"),
          jsx("button", { onClick: function () { setDish(pickDish()); }, children: "换一道" }, "b"),
        ],
      });
    }
  );
});
```

> 上面 `EatTodayView` 只是示例函数，实际写时把 `React`/`jsx`/`pickDish` 都放在 `factory` 闭包里，组件内直接用。

### 5.7 右侧边栏面板（若要「今天吃什么」常驻右栏）

右侧边栏的扩展分**两步**：①`ctx.sidebarRightTabs.register(definition)` 声明一种 tab 类型（并可选在 guide 页放入口）；②向 keyed slot `sidebar.right.pane.tab`（+可选 `.title`）注册正文。

官方参考：`reference/subsystems/sidebar-right.md`；实测第三方实现（`dsh-context`）如下（`profile/node_modules/dsh-context/lib/client.js` 末尾的 `Bm` 函数）：

```js
const TAB_ID = "dsh-eat-today";
const TAB_KIND = "dsh-eat-today";   // kind 是用户打开时点名的类型；可自建

export function apply(ctx) {
  // 用 ctx.inject 而非插件级 inject：sidebarRightTabs 由 ui-sidebar-right 提供，可能不存在
  ctx.inject(["sidebarRightTabs", "slots"], function (sctx) {
    var disposers = [];
    var own = function (d) { if (typeof d === "function") disposers.push(d); return d; };

    // ① tab 类型定义（静态：无 hook；id 全局唯一；kind 不唯一）
    own(sctx.sidebarRightTabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      title: function () { return "今天吃什么"; },
      // guide 入口：出现在右侧栏「引导」页，点一下即以本类型打开页面
      // dsh-context 实测写法是数组；官方文档写单个对象。两种都试过可用（推测 schema 支持 union）
      guide: [{
        id: TAB_ID,
        order: 30,
        title: function () { return "今天吃什么"; },
        description: function () { return "随机决定今天吃什么"; },
      }],
      // 也可加 patterns/canOpen/keepMounted/priority，见官方 sidebar-right.md
    }));

    // ② 正文（keyed by tab 类型 id，注意是 id 不是 kind）
    own(sctx.slots.inject("sidebar.right.pane.tab", function () {
      return sctx.slots.register(
        { name: "sidebar.right.pane.tab", key: TAB_ID },
        function EatTodayPane(props) {
          // props.useTabInfo() 可读 { sidebar, panel, tab }（导航、signal、actions）
          return jsx("div", { style: { padding: "16px" }, children: "今天吃：番茄牛腩饭" });
        }
      );
    }));

    // ③ 可选：实时 chip 标题（不注册则用打开时捕获的 title(address) 文本）
    own(sctx.slots.inject("sidebar.right.pane.tab.title", function () {
      return sctx.slots.register(
        { name: "sidebar.right.pane.tab.title", key: TAB_ID },
        function EatTodayTitle() { return jsx("span", { children: "今天吃什么" }); }
      );
    }));

    return function () { disposers.forEach(function (d) { d(); }); };
  });
}
```

**怎么打开这个面板**（三选一）：

1. 用户在右侧栏「引导页」点入口（上面 `guide` 配好即可）；
2. 用底部/设置里的按钮命令式打开：

```js
function openEatTodayTab(ctx) {
  var sr = ctx.get("sidebarRight");
  if (sr === undefined || typeof sr.openTab !== "function") return false;
  try { sr.openTab("dsh-eat-today"); return true; } catch (e) { return false; }  // 无前台会话时会抛
}
```

3. 用资源地址打开（`openResource`，需要 `dsh-resource://` 地址，较绕，不推荐）。

证据汇总：tab 类型注册 `ctx.sidebarRightTabs.register`、导航 `ctx.sidebarRight.openTab/openResource`、正文/标题 slot 的 keyed 语义、`useTabInfo()` 均见官方 `reference/subsystems/sidebar-right.md`；keyed 声明在 `dsh-client-ui-sidebar-right/lib/client.js:5683`；正文渲染 `renderSlot("sidebar.right.pane.tab", {}, { entryKey: definition.id, ... })` 在 `:1601`；真实第三方写法见 `dsh-context` 的 `Bm`；`openTab` 的可用性探测见 `dsh-context` 的 `Zm`（`ctx.get('sidebarRight')` + `typeof openTab==='function'`）。

> 右侧栏的坑：body 只在**前台会话 + 栏展开**时渲染（官方 sidebar-right.md「Slot 与 owner props」）；`openTab` 在无挂载会话面时抛错。

### 5.8 备选挂载点

| slot | 适合做什么 | 备注 |
|---|---|---|
| `conversation.input.dock`(list/session) | 输入框下方的常驻小挂件/按钮（点开弹窗或切 tab） | owner `ui-conversation` 自己在此注册队列 dock（`lib/client.js:19942`） |
| `conversation.input.overlay`(list/session) | 浮在输入区上方的弹层（命令菜单、选择器） | `dsh-context` 用它注册 modal（`id:'context-modal', order:10`）；适合「今天吃什么」的选择弹窗 |
| `conversation.chat.turnTail`(list/session) | 每个助手回合结束后的卡片 | 适合把推荐结果嵌进对话；示例 `dsh-client-ui-plan/lib/client.js:775` |
| `shell.overlay`(list/root) | 全局浮层/模态 | 渲染点 `dsh-client-ui-layout/lib/client.js:725` |
| `plugins.bundle.config`(keyed/root) | 插件详情页的配置卡片（key = npm 包名） | `dsh-context` 用法：`{name, key:'dsh-context', locale, inject}` |
| `settings.general.item`(list/root) | 设置页通用条目（含开关/行） | 例：`dsh-client-ui-conversation/lib/client.js:22614`（Enter 行为行）、语言行 |

---

## 6. client 与 host 的通信

### 6.1 client 半能否只靠静态数据工作？

**能，且这是「今天吃什么」的推荐路线。**

- client bundle 自带数据与逻辑；种子模块已提供 react/react-dom/primitives/client-store。
- `dsh-context` 这类重量级插件的 client 半也只 require 4 个种子模块（`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`；`dsh-context/lib/client.js:12`），其余全靠 `ctx.<service>`。
- 唯一需要的"数据"是历史/偏好：用 client store 的 persist 写 localStorage 即可（§6.3），完全不需要 host 代码。

### 6.2 四条通道对比

| 通道 | 推荐度 | 说明 |
|---|---|---|
| **localStorage（经 `defineStore` persist）** | ★★★★★ | 零 host 代码、零协议；缺点是绑 origin（见 §6.3 警告） |
| **host tool（模型中介）** | ★★★ | 想跨设备/跨端口持久化时，让 host 工具读写文件，UI 只展示结果；不用写 RPC |
| `ctx.webServer.register()` + `fetch` | ★★ | host 半可注册 HTTP 路由（`dsh-client-hmr/lib/index.js:140-152` 是真实用法）；但 client 侧鉴权/信任边界**未验证**（`/api` 有 trust check，自定义路由是否放行未取证），不建议 |
| Typert Remote（`ctx.remote.<ns>`） | ★ | 官方正式的 Host↔Client RPC；需要**构建期代码生成**（`typert.host.js` / `typert.remote-client.js` / client 产物，见 `dsh-commands/lib/typert.host.js`、`dsh-plugin-manager/lib/typert.*.js`），且要 `@Remote` 装饰器 + descriptor 注册（官方 `reference/subsystems/typert.md`）。工作量远超本插件收益 |

### 6.3 推荐：`defineStore` + localStorage 持久化

`@deepseek-ai/dsh-client-store` 是**种子模块**，导出 `createSnapshotStore(init, {flush, persist})` 与 `defineStore(decl)`（`node_modules/@deepseek-ai/dsh-client-store/lib/index.js:70-176`）：

- `defineStore({ init: () => state, persist: "name", actions: {...} })` 返回 **store handle**（`{spec, create(scopeKey)}`），正是 `ctx.slots.register({store})` 需要的"币种"（`:147-176`）。
- `persist` 会：初始化时 `localStorage.getItem(name)` 反序列化；之后每次变更 `localStorage.setItem(name, JSON.stringify(state))`（`:111-126`）。**注意它是整值 JSON，不是增量**。

```js
// 在 factory 闭包里（模块级，不依赖 React）
var defineStore = require("@deepseek-ai/dsh-client-store").defineStore;

var eatStore = defineStore({
  init: function () { return { dish: null, history: [] }; },
  persist: "dsh-eat-today",        // localStorage key
  actions: {
    pick: function (draft, dish) {
      draft.dish = dish;
      draft.history = [dish].concat(draft.history).slice(0, 50);
    },
    clear: function (draft) { draft.history = []; draft.dish = null; },
  },
});

// 注册时挂上 store → 组件收到 useStore / actions（见 §5.3）
ctx.slots.inject("conversation.hero.options", function () {
  return ctx.slots.register(
    { name: "conversation.hero.options", id: "eat-today", order: 10, store: eatStore },
    function EatCard(props) {
      var dish = props.useStore(function (s) { return s.dish; });
      return jsx("div", { onClick: function () { props.actions.pick(pickDish()); }, children: dish ? dish.name : "点我决定" });
    }
  );
});
```

**⚠️ localStorage 的 origin 陷阱（本机实测的运行时配置）**：Web GUI 是 `http://127.0.0.1:<port>`，而 desktop profile 的运行时 patch 里 webserver `port: 0`（随机端口）——`profile/desktop-next.runtime.patch.json` 第 4-6 行。**端口一变，localStorage 就是另一个 origin，历史丢失**。若「今天吃什么」需要长期历史，请用 host 工具落盘（§6.4）或接受丢失。

### 6.4 可选：host tool 把历史写到磁盘

若想持久化，最省事的组合是：UI 用 client state 展示；"保存今日结果"由一个 host 工具完成（模型调用），host 侧用 `node:fs` 写入 `dshHomePath("eat-today")`（`dshHomePath` 服务的签名未完全验证，见 §3.5）。这样**不需要任何 client↔host 私有协议**，走的是已有的 tool 通道。

### 6.5 明确不推荐

- 直接 `fetch("/api/...")` 打内部 API：内部 API 由 Typert Gateway + connection generation 管理，签名/请求体是生成产物，手写极脆。
- 自建 WebSocket：`dsh-client-connection` 已拥有连接与 generation，自建会与 HMR/gate 冲突。
- 用 host 半写文件 + client 直接 `fetch("/plugins/<pkg>/assets/...")` 读：assets 路由只服务静态资源 exports，写不满语义（`dsh-client-modules/lib/index.js:1050-1088`）。

---

## 7. 安装与热加载

### 7.1 profile 的结构（本机实例）

`<USER_HOME>\.dsh\profiles\desktop\`：

```
package.json                 # name/private/dependencies + dsh.profile.bundles（有序 bundle 列表）
cordis.patch.yml             # 用户 patch 层（在所有 bundle 层之后应用）
cordis.yml                   # 空根配置 []（每次启动被重写，别编辑）
pnpm-workspace.yaml          # packages:[.] / nodeLinker: hoisted / autoInstallPeers: false
desktop-next.cordis.patch.json / desktop-next.runtime.patch.json   # 桌面壳注入的额外 patch
node_modules/                # pnpm hoisted；第三方插件装在这里
```

当前 `dsh.profile.bundles`（`profile/package.json`）：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dshmarket`、`@agents-anywhere/dsh-bridge-next`、`…agent-team-profile`、`…voice-input-bundle`、`dsh-context`、`dsh-whale-widget`。

**层顺序**（官方 `develop/basic/publish.md`「加载顺序」，源码 `dsh-app-boot/lib/index.js:1317` 附近）：

1. `dsh.profile.bundles` 里每个 bundle 的 `dsh.bundle.patch` 文件，按列表顺序；
2. profile 自己的 `cordis.patch.yml`；
3. `$DSH_HOME/cordis.patch.yml`（home 级）；
4. `--patch` overlay（按 argv 顺序）。

后层按行覆盖，且**替换整行 config（不深合并）**。

### 7.2 本地 link 安装（两种等价写法）

**CLI（推荐）**——官方文档明确 `dsh plugin add <本地路径>` 会 pnpm link 并**自动把该包追加进 `dsh.profile.bundles`**（`develop/basic/publish.md`「安装进 profile」）：

```powershell
# 在 <你的插件目录> 下（插件目录 dsh-eat-today\ 旁边）
# 注意：本机没有全局 dsh CLI；桌面版的 dsh CLI 入口在安装目录（见下）
& 'D:\dsh\DSH NEXT\DSH NEXT.exe' ... # Electron 壳不是 CLI，实际请用打包内 CLI 或手改 profile（见下）
```

> **未验证**：本机桌面版是否暴露可用的 `dsh` CLI 可执行文件（`app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js` 存在，但启动器是 Electron 壳）。若拿不到 CLI，用下面的等价手工方式，效果相同。

**手工等价（确定可行）**：

1. 把插件目录放进 profile 依赖（pnpm link 协议）：

```json
// profile/package.json
{
  "dependencies": {
    "dsh-eat-today": "link:D:/dsh test/dsh-eat-today"
  }
}
```

2. 在 profile 里跑一次安装，让 `node_modules/dsh-eat-today` 出现（pnpm 在 profile 目录执行；本机 pnpm 路径：`<USER_HOME>\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`，用 node 调）：

```powershell
$node='<USER_HOME>\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe'
$pnpm='<USER_HOME>\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
& $node $pnpm install --dir '<USER_HOME>\.dsh\profiles\desktop'
```

3. 把包名追加到 bundle 列表（**这是激活的关键**）：

```json
// profile/package.json
"dsh": { "profile": { "bundles": [ "...", "dsh-eat-today" ] } }
```

4. 重启 DSH（host 侧扫描只在启动时），之后改 `lib/client.js` 即可热载。

**另一种不改 bundles 的做法**：在 `profile/cordis.patch.yml` 直接插一行（等价于 bundle patch 层）：

```yaml
- insert:
    - id: dsh-eat-today
      name: dsh-eat-today
```

> 区别：走 bundles 会让包自己的 `cordis.patch.yml` 生效（推荐，和 dsh-context 一致）；写 profile patch 则是用户层覆盖，包自身 patch 不参与。

**验证安装**（官方文档给出）：

```powershell
# dsh --profile desktop --dump-config    # 输出里应出现 "# == dsh-eat-today" 层
```

> 本机 CLI 调用方式未验证（同上）。

**plugin_manager 的 `link:` 支持**：GUI/管理器层解析安装 spec 的代码接受 `link:`/`file:` 前缀，但**要求绝对路径**（`dsh-plugin-manager/lib/types/install-spec.js:58-87`，`parseInstallSpec`：`link:`/`file:` 剥前缀后 `isAbsolute` 校验，相对路径直接拒绝）。所以写 `link:D:/dsh test/dsh-eat-today` 合法，`link:./dsh-eat-today` 非法。

### 7.3 依赖如何解析（host 半 import `@deepseek-ai/*` 由谁提供）

- 双锚点：**先从 dsh 安装（app.asar）解析，再从 profile 目录解析**；profile `node_modules` 里 pnpm 管理的条目优先（`dsh-app-boot/lib/index.js:1317` 的 profile 模块注释）。
- 运行中的 DSH 自带 `@deepseek-ai/cordis`、`dsh-tools`、`schemastery` 等；profile 的 `pnpm-workspace.yaml` 设了 `autoInstallPeers: false`，peer 不会被装第二份。
- 因此 host 半可以 `import "@deepseek-ai/dsh-tools"` / `import "@deepseek-ai/schemastery"`，但**建议在 `peerDependencies` + `devDependencies` 中声明**（官方 `develop/basic/publish.md`：需要与宿主共享实例的 dsh 包同时写 peer 与 dev）。
- 通过 link 安装的目录保留自己的 `node_modules`；第三方独立依赖（如 `zod`）放 `dependencies`。

### 7.4 客户端 bundle 变更 = 热载（无需刷新页面）

机制（源码级）：

1. `dsh-client-hmr` host 半每 `pollIntervalMs`（默认 **500ms**）stat 每个 graph row 的 bundle（`dsh-client-hmr/lib/index.js:22`、`:63-104`）；
2. 变化 → `ctx.clientModules.rebuilt(id)` → 用 mtime/ctime/size 派生新 `rev`，重组合 graph（`dsh-client-modules/lib/index.js:687-705`），通过 SSE `/plugins/events` 推 `{type:'rebuilt', id, rev}`（`dsh-client-hmr/lib/index.js:154-161`）；
3. 浏览器 `ClientEntries.reload(id, rev)`：拆掉旧 fiber → `removeOwnedStyles(id)` 删除该插件所有 `<style data-plugin=...>` → 重新 import bundle（重新注册 factory）→ `entry.refresh()`（`dsh-client-modules/lib/client.js:431-505`）；
4. 新 factory materialize 时重新注入 CSS。

**前提**：Host release 必须匹配（`release.version`+`commit` 相同）。正常开发（不重启桌面版）一直匹配；一旦 Host 升级/重启换了 release，页面会提示并暂停应用图更新，需刷新页面（`dsh-client-modules/lib/client.js:227-291`；官方 `reference/subsystems/client-modules.md`「Host release 变化」）。

### 7.5 什么需要重启 vs 刷新

| 改动 | 是否需要手动操作 |
|---|---|
| `lib/client.js`（含内联 CSS） | **不需要**：≤500ms 后自动热载 |
| `cordis.patch.yml` 里该插件的 config | 官方 `develop/basic/config.md`：config 变更触发插件热替换（host 侧 Cordis loader） |
| `package.json`（新增/修改 `dsh.client`、`exports`、bundle patch 路径） | **需要重启 DSH**（包元数据缓存到进程重启，§2.5） |
| host 半代码 `lib/index.js` | 需要重启（打包版没有 host 侧文件 watch 的保证） |
| 新增/删除 profile bundle 行 | 需要重启 |
| Host 升级（release 变） | 刷新页面 |

---

## 8. 版本兼容与实现注意事项（清单）

1. **`platform: "web"` 必须写**：不是 `"web"` 的 client 声明会被静默忽略（不报错、不加载），表现为"插件装了但 UI 没出现"（`dsh-client-modules/lib/index.js:790`）。
2. **id 必须等于包名**：`__ModuleLoader__.load({id})` 与 package name 不一致 → 启动报 `could not load "<pkg>": ... loaded without registering "<pkg>"`（`dsh-client-modules/lib/client.js:745-777`）。
3. **不要用 ESM 语法写 client bundle**：它是 classic script（`defaultLoadBundle` 用 `<script>` 无 `type=module`，`:580-594`）。
4. **不要 require 未声明的包**：只有种子清单可白拿；其余要进 `dsh.client.inject`/`external`，否则 `missed the module table`。
5. **DOM 副作用只能在 factory 内**：bundle 顶层执行时模块系统可能还在 queue 模式；且懒 CJS 契约要求副作用在 materialize（`:16-24`）。
6. **向未声明 slot 注册必然失败**：确认目标 slot 在当前组合里存在（不同 bundle 组合会改变声明）；用 `ctx.slots.inject(key, cb)` 等待更稳（`dsh-client-ui-renderer/lib/client.js:1368`）。
7. **single slot 同优先级只能有一个 occupant**：第二个会抛 `single slot "x" already has a registration at priority 0`；想叠加请用 list 的新 id，或换 priority（`dsh-client-ui-slots/lib/index.js:170-186`）。
8. **list/keyed 必须带 id/key**：否则立即抛（同文件 :175-186）。
9. **别在 `plugins.bundle.config` 用错 key**：key 是 **npm 包名**（`dsh-context` 用 `key: 'dsh-context'`）。
10. **`engines.dsh` 写对**：本机 0.2.2-rc.1；不满足会被启动拒绝，需要 profile `compatibility.json` 精确豁免。
11. **HMR 会删你的 `<style>`**：重新注入依赖 factory 重新执行；不要在模块顶层缓存"已注入"标志（会因样式被删而失效）。用 `document.querySelector('style[data-plugin-css=...]')` 判断（dsh-context 就是这么写的）。
12. **`ctx.get(service)` vs `ctx.inject`**：可选依赖（如 `sidebarRight`、`sidebarRightTabs`）用 `ctx.inject([...], cb)` 或 `ctx.get(...)` 探测，不要写进插件级 `inject`（服务不存在会导致插件永不激活）。

---

## 9. 未验证 / 需要 Lead 决断的点

| # | 事项 | 状态 |
|---|---|---|
| 1 | 桌面版是否提供可用的 `dsh` CLI（`dsh plugin add`） | **未验证**（app.asar 内有 `@deepseek-ai/dsh/lib/bin.js`，但启动器是 Electron 壳）。可行替代：手改 profile `dependencies` + `dsh.profile.bundles`（§7.2） |
| 2 | `dshHomePath` 服务的准确签名/是否默认挂载 | **未验证**（从 dsh-context 的 `ctx.get('dshHomePath')` 调用点反推） |
| 3 | `sidebarRightTabs.register({guide})` 是对象还是数组 | 官方文档写单对象，`dsh-context` 实际传数组；**建议数组**（本机实测该插件可用） |
| 4 | client 插件 export default 形态是否被接受 | **未验证**（官方 client 包与 dsh-context 都用命名导出 `apply/inject/name`；Cordis 通用支持 default，但 client loader 路径未单独取证）→ **实现请用命名导出** |
| 5 | 自定义 `webServer` 路由的鉴权/信任策略 | **未验证**（`/api` 有 trust check；自定义路由未见策略代码）→ 不推荐 |
| 6 | Typert Remote 代码生成的 CLI 命令 | **未验证**（只确认产物文件名 `typert.host.js`/`typert.remote-client.js` 存在于多个包） |
| 7 | `dsh-market` 社区市场的上架/审核规则 | 未调研（与实现无关） |
| 8 | 「今天吃什么」是否要 host 工具（让模型参与推荐） | **需 Lead 决断**：纯 UI（零 host 风险、立即可用）vs 加 `eat_today` 工具（模型能推荐、可写历史，但增加 schema/兼容面） |
| 9 | 历史持久化策略 | **需 Lead 决断**：localStorage（简单，但随机端口会丢）vs host 文件（需实现 host 侧 + 工具通道） |
| 10 | 是否需要 i18n（中/英） | 可选：`ctx.locale.register(ns, {zh,en,...})` + `locale: ns`；只做中文可省略，避免"声明 locale 但没字典"的坑 |

---

## 10. 给实现者的 10 条要点

1. **形态**：`dsh-eat-today` = bundle（`dsh.bundle.patch`）+ host 半（空 `apply` 即可）+ client 半（`dsh.client.platform:"web"` + `exports["./client"]`）。三者缺一不可。
2. **client bundle 手写**：classic script，`window.__ModuleLoader__.load({id: 包名, factory: (require) => 模块exports})`；不写 import/export、不写 JSX；`require("react")`/`require("react/jsx-runtime")` 白拿。
3. **UI 用 slots 扩展，绝不 import 别的功能包运行时**：`ctx.slots.inject(key, () => ctx.slots.register({name, id|key, order, ...}, Comp))`；`register` 已自动绑定 fiber，不需再包 `ctx.effect`。
4. **首选挂载点 `conversation.hero.options`**（新会话欢迎页卡片）：`{name, id:"eat-today", order:10}`；组件收到 `sessionId/useSession/...` 等标准 props。
5. **第二挂载点 `conversation.view`**（会话内 tab）：`{name, id:"eat-today", order:100, label: () => "今天吃什么"}`；这就是 dsh-context 的 "Context 标签页" 同款。
6. **右栏面板要三步**：`ctx.sidebarRightTabs.register({id, kind, title, guide:[...]})` + `slots.register({name:"sidebar.right.pane.tab", key: id}, Body)` + 可选 title slot；打开用 guide 入口或 `ctx.get("sidebarRight").openTab(kind)`。
7. **数据自带**：菜谱静态数组放 client bundle；历史/偏好用 `require("@deepseek-ai/dsh-client-store").defineStore({init, persist:"dsh-eat-today", actions})` + `register({store})`，组件拿 `useStore/actions`。
8. **样式**：走 `--dsw-alias-*`/`--dsw-radius-*` 主题变量；CSS 在 factory 内注入 `<style data-plugin="dsh-eat-today" data-plugin-css="dsh-eat-today/base.css">`，用 `style[data-plugin-css=...]` 做幂等（HMR 会删旧 style）。
9. **安装**：`profile/package.json` 加 `"dsh-eat-today": "link:D:/dsh test/dsh-eat-today"` → pnpm install → 追加到 `dsh.profile.bundles` → 重启；之后改 `lib/client.js` 由 `dsh-client-hmr`（500ms 轮询 + `/plugins/events` SSE）自动热载，**不用刷新页面**。
10. **兼容面**：`engines.dsh: ">=0.2.2-rc.1"`；`platform:"web"`；client module id = 包名；bundle 顶层零副作用；可选服务用 `ctx.inject`/`ctx.get` 探测而不是硬 inject。

---

## 附录 A：slot 清单复现脚本（本机可直接跑）

把结果写到临时文件再搜，避免长输出被截断：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$code = @'
const fs=require('fs');
const base='D:/dsh/DSH NEXT/resources/app.asar/node_modules/@deepseek-ai/';
const pkgs=fs.readdirSync(base).filter(n=>fs.statSync(base+n).isDirectory());
const map=new Map();
for(const p of pkgs){
  const f=base+p+'/lib/client.js'; if(!fs.existsSync(f)) continue;
  const s=fs.readFileSync(f,'utf8');
  let m;
  const reUse=/name:\s*["'`]([A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)+)["'`]/g;
  while((m=reUse.exec(s))){ if(!map.has(m[1])) map.set(m[1],{used:new Set(),kind:'',scope:'',by:new Set()}); map.get(m[1]).used.add(p); }
  const reDecl=/["']([a-z][A-Za-z0-9_\-]*(?:\.[A-Za-z0-9_\-]+)+)["']\s*:\s*\{\s*kind:\s*["'](single|list|keyed|chain)["']\s*,\s*scope:\s*["'](root|session)["']/g;
  while((m=reDecl.exec(s))){ if(!map.has(m[1])) map.set(m[1],{used:new Set(),kind:'',scope:'',by:new Set()}); const e=map.get(m[1]); e.kind=m[2]; e.scope=m[3]; e.by.add(p); }
}
const rows=[...map.entries()].sort().map(([n,e])=>`${n} | kind=${e.kind||'?'} scope=${e.scope||'?'} | declBy=${[...e.by].join(',')||'-'} | usedBy=${[...e.used].join(',')}`);
fs.writeFileSync(process.env.TEMP+'/dsh-slots.txt', rows.join('\n'));
console.log('slots', map.size);
'@
$code | Out-File -Encoding utf8 "$env:TEMP\scan-slots.js"
& 'D:\dsh\DSH NEXT\DSH NEXT.exe' "$env:TEMP\scan-slots.js"
Get-Content "$env:TEMP\dsh-slots.txt"
```

## 附录 B：证据来源索引

| 主题 | 主证据 |
|---|---|
| manifest 字段 | `profile/node_modules/dsh-context/package.json`；`dsh-client-modules/lib/index.js:200,790,792,1050-1088`；`dsh-app-boot/lib/index.js:1065,1097,1317,1335` |
| client 扫描/校验 | `dsh-client-modules/lib/index.js:602-631,783-803,908-969`；`lib/client.js:61-75`；官方 `reference/subsystems/client-modules.md` |
| loader 协议 | `dsh-client-modules/lib/client.js:1-37,580-631,704-853`；官方 `reference/subsystems/client-modules.md` |
| 种子模块 | `dsh-web-frontend/dist/assets/index-BgUyXZcc.js:196`（`YZ()`）；`app.asar/package.json`（react 18.3.1） |
| slots 核心 | `dsh-client-ui-slots/lib/index.js:47-577,163,74`；`dsh-client-ui-renderer/lib/client.js:1305,1348,1368,1813,435-456,736-796`；官方 `reference/subsystems/slots.md` |
| slot 声明/渲染实例 | `dsh-client-ui-conversation/lib/client.js:20556,20711,22871,22622`；`dsh-client-ui-sidebar-right/lib/client.js:5683,1601` |
| 真实 client 注册样例 | `profile/node_modules/dsh-context/lib/client.js`（tail：`conversation.view`、`conversation.input.overlay`、`plugins.bundle.config`、`sidebarRightTabs`/`pane.tab`） |
| CSS 注入 | `dsh-context/lib/client.js` CSS 段（`dataset.plugin`/`dataset.pluginCss`）；`dsh-client-modules/lib/client.js:312-315,617-631` |
| 主题变量 | `dsh-client-ui-theme/lib/client.js` + `dsh-web-frontend/dist/assets/*.css`（统计 417 个 `--dsw-*`） |
| tools | `dsh-tools/lib/index.js:310-359,433-445,440`；`dsh-tool-todo/lib/index.js`；官方 `reference/subsystems/tools.md` |
| commands | `dsh-commands/lib/index.js:78,149-204,266-269`；官方 `reference/subsystems/commands.md` |
| 持久化 | `dsh-storage/lib/index.js:104-138`；`dsh-client-store/lib/index.js:70-176` |
| 安装/层顺序 | 官方 `develop/basic/publish.md`；`dsh-app-boot/lib/index.js:1317`；`dsh/lib/plugin-DscIHF4k.js:64-100`；`profile/pnpm-workspace.yaml` |
| HMR | `dsh-client-hmr/lib/index.js:1-172`；`dsh-client-modules/lib/index.js:687-705`；`dsh-client-modules/lib/client.js:431-505` |
| 版本兼容 | `dsh-app-boot/lib/index.js:1097` 附近 `unmetRequirements`；官方 `develop/basic/publish.md` |
| 右栏 | 官方 `reference/subsystems/sidebar-right.md`；`dsh-client-ui-sidebar-right/lib/client.js:5683,1601`；`dsh-context` 的 `Bm` |
