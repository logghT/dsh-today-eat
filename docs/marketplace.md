# 发布到 DSH 插件市场

> 结论先说：DSH 目前**没有官方集中上传/审核后台**。所谓「插件市场」由几层组成：官方插件索引（plugin index）+ 社区目录（awesome-dsh-plugin / dsh-market / dshplugin.app）。真正能被收录的入口是社区目录的 PR；官方索引只负责把 npm/GitHub 上的包聚合成可安装列表。

## 1. 发布前已经准备好的东西

| 项 | 状态 | 位置 |
| --- | --- | --- |
| `package.json` 可安装声明 `dsh.bundle` | ✅ | `package.json` → `dsh.bundle.patch` |
| client 声明 `dsh.client.platform = web` | ✅ | `package.json` |
| `private` 改为 `false`、`license`/`author`/`keywords`/`engines.dsh` | ✅ | `package.json` |
| MIT LICENSE | ✅ | `LICENSE` |
| 市场卡片图标（512×512 PNG） | ✅ | `assets/icon.png` |
| `screenshots.json`（8 张，相对路径） | ✅ | `screenshots.json` |
| 数据校验 / 单测 / host & client 烟测 | ✅ | `npm run validate:data`、`npm test`、`npm run smoke` |
| 重复检查脚本 + 去重 | ✅ | `scripts/check-duplicates.mjs`、`docs/duplicate-audit.md`、`docs/dedupe-report.md`（同名 0 组） |
| 条目 YAML 模板 | ✅（需填 owner/repo） | `docs/awesome-dsh-plugin-entry.yml` |
| npm 包名可用性 | ✅ `dsh-today-eat` 未被占用（查询 404） | — |
| 公开 GitHub 仓库 | ⬜ **待创建**（仓库需满 1 天） | — |
| `dsh-plugin` topic | ⬜ 创建仓库后添加 | — |
| npm 发布 | ⬜ 可选，需 npm 登录 | — |

当前可分发产物：
- `dist/github-upload/`：**已整理好的 GitHub 上传目录**（113 个文件，约 5.5 MB；只含仓库需要的源码/文档/数据，已排除 `node_modules`、`dist`、密钥与临时文件）。
- `dist/dsh-today-eat-0.4.0-source.zip`：同一批文件的压缩包（备份/传输用，**不要直接拖 zip 到 GitHub**，GitHub 会把它当二进制文件）。
- `dist/dsh-today-eat-0.4.0.tgz`：npm 包（可选发布）。

## 2. 当前环境缺什么

这台机器目前**没有 git / GitHub CLI / npm 登录凭据**，`<你的插件目录>` 也还不是 git 仓库，所以无法从这里直接创建仓库、push 或提交 PR。实际发布需要你提供：

1. GitHub 账号（或已登录的 `gh`/git 环境）；
2. 一个新的公开仓库名（建议 `dsh-today-eat`）；
3. （可选）npm 账号，用于 `npm publish`，让市场显示下载量。

在此之前，本目录已经是可打包、可安装的完整版本。

## 3. 最短发布路径（推荐）

### 3.1 创建 GitHub 仓库并上传

**不用 git 的网页上传（推荐给第一次用 GitHub 的人）**

1. GitHub 右上角 `+` → **New repository**；
2. Repository name 填 `dsh-today-eat`，选 **Public**；**不要**勾选 Add a README / .gitignore / license（避免和上传文件冲突）；
3. 创建后点仓库页面的 **uploading an existing file**；
4. 打开 `<你的插件目录>\dist\github-upload\`，`Ctrl+A` 全选里面的**文件和文件夹**，拖进浏览器上传区（拖进去的是内容，不是 `github-upload` 这层文件夹；根目录必须能看到 `package.json`）；
5. 等文件上传完（约 113 个文件、5.5 MB，可能需要一两分钟），Commit message 填 `feat: dsh-today-eat 0.4.0`，点 **Commit changes**；
6. 仓库页 **Settings → Topics** 添加 `dsh-plugin`；
7. 确认仓库根目录直接是 `package.json`、`lib/`、`data/`、`src/` 等，而不是套了一层文件夹。

> 如果浏览器一次拖 113 个文件卡住：先上传根目录的 6 个文件（`package.json`、`cordis.patch.yml`、`README.md`、`LICENSE`、`screenshots.json`、`.gitignore`）和 `lib/`，再分几次上传 `data/`、`src/`、`docs/`、`assets/`、`scripts/`、`tests/`。不要上传 `node_modules`、`dist`、`.memsearch`。

**有 git/gh 时**

```text
# 在 GitHub 新建 public repo：<owner>/dsh-today-eat
git init
git add .
git commit -m "feat: dsh-today-eat 0.4.0 — nine meal phases, diet assistant with 1000 recipes"
git branch -M main
git remote add origin https://github.com/<owner>/dsh-today-eat.git
git push -u origin main
```

推送后到仓库 **Settings → Topics** 添加 `dsh-plugin`。

### 3.2 发布 npm（可选，但推荐）

```text
npm login
npm publish --access public
```

发布后检查 npm 包的 `repository` 字段需指回仓库（本目录的 `package.json` 目前先留空，等仓库地址确定后再补）：

```jsonc
"repository": { "type": "git", "url": "https://github.com/<owner>/dsh-today-eat.git" }
```

### 3.3 提交社区目录条目

1. Fork [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)；
2. 从本目录复制 `docs/awesome-dsh-plugin-entry.yml`，改名为
   `data/plugins/<owner>__dsh-today-eat.yml`，并把 `<owner>` 全部替换成真实 GitHub 用户名/组织名；
3. 一个 PR 只加这一个文件（目录规则：一个 PR 最多 3 条）；
4. 等 CI + 维护者 review。

条目 YAML 的字段含义：

```yaml
url: https://github.com/<owner>/dsh-today-eat   # 必须与仓库完全一致
name: <owner>/dsh-today-eat                    # 列表里显示的链接文字
category: usage                                 # 生活实用工具；分类不准确维护者会改，不会打回
description:
  en: '...'                                     # 必填；必须与代码实际功能一致
  zh: '...'                                     # 可选；中文
icon: https://raw.githubusercontent.com/<owner>/dsh-today-eat/main/assets/icon.png
```

> 描述中不能出现 `: `（冒号+空格）除非整体加引号；不要写营销词/夸大数字。条目里**不要**写 `npm:` 字段，npm 关联由 registry 自动识别。

### 3.4 官方插件索引（可选，进阶）

官方支持自建插件索引，把多个来源（npm 包 / git commit）聚合成一个可安装列表，适合团队/私有分发：

- 文档：<https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market>
- 参考生成器：`dsh-plugin-market-generator`
- 索引格式 `format: 1`，包含 `plugins[]`、`versions[]`、`source`；索引本身可静态托管（GitHub Pages 亦可）。

个人插件不需要走这一步；先上社区目录即可。

## 4. 发布前最后检查清单

```text
# 在 <你的插件目录>
node scripts/validate-data.mjs          # 1000 菜品 / 1000 菜谱
node --test "tests/core/*.test.mjs" "tests/data/*.test.mjs" "tests/host/*.test.mjs"
node scripts/build-client.mjs           # 重新生成 lib/client.js
node scripts/smoke-host.mjs
node scripts/smoke-client.mjs
node scripts/check-duplicates.mjs       # 只读审计
```

真机安装验证（干净 profile）：

```text
dsh plugin add https://github.com/<owner>/dsh-today-eat
```

打开面板确认：窗口右下浮窗出现、面板 5 个 tab、菜谱库显示 1000 道、附近（无 Key）给出兜底搜索词、`/food` 可用。

## 5. 已知发布注意点

- **仓库年龄**：awesome-dsh-plugin 的 CI 要求仓库创建满 **1 天**；刚建好的仓库当天提交会被拦，等一天后重提即可，不影响收录。
- **只需要 `dsh.bundle`**：只声明 `dsh.client` 的插件不可安装，会被 CI 拒绝；本插件两者都有。
- **README 语言**：目录只强制英文 description；README 中文为主没问题，但建议保留顶部英文一句话（已加）。
- **截图**：`screenshots.json` 是数组，路径相对仓库根，不能以 `/` 开头或含 `..`；不要用第三方图床。
- **图标**：必须是 GitHub 托管的 PNG/JPG/WebP，SVG 与第三方图床会被拒。
- **安全审查**：收录不等于安全审计。本插件不混淆、不收集数据、只有「附近吃」会请求高德 API；已在 README 「数据存放与隐私」说明。
- **菜单/价格**：连锁点单建议来自本地维护的公开菜单快照，描述里已注明「以门店为准」，不要改成实时菜单的承诺。

## 6. 需要你确认

- GitHub owner/组织名与仓库名（默认建议 `dsh-today-eat`）；
- 是否同时发布 npm（需要 npm 账号）；
- 发布后是否要把条目 PR 的链接/收录状态更新到发布记录中。
