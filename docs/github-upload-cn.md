# GitHub 网页上传保姆级步骤（中文对照）

> GitHub 没有官方中文界面，最省事的办法是让浏览器翻译：
> - **Edge**：页面空白处右键 →「翻译为中文」；或点地址栏右侧的翻译图标。
> - **Chrome**：页面空白处右键 →「翻译成中文」；或点地址栏右侧的翻译图标。
>
> 翻译后按钮会变成中文；下面同时给出英文原文，找不到时按英文找。

## 第 1 步：新建仓库

1. 登录 GitHub 后，点右上角的 **`+`**。
2. 菜单里点 **`New repository`**（新建仓库）。
3. 填写：
   - **`Repository name`**（仓库名）：`dsh-today-eat`
   - 下面选 **`Public`**（公开）
   - **不要**勾选：
     - `Add a README file`
     - `Add .gitignore`
     - `Choose a license`
4. 点绿色按钮 **`Create repository`**（创建仓库）。

## 第 2 步：上传文件

1. 创建完成后，页面中间有一行小字：
   **`uploading an existing file`**（上传已有文件），点它。
2. 打开电脑上的文件夹：
   `<你的插件目录>\dist\github-upload\`
3. 按 **Ctrl+A** 全选里面的**文件和文件夹**（不要选 `github-upload` 这一层文件夹本身）。
4. 把它们拖进浏览器中间的虚线框：
   **`Drag files here to add them to your repository`**（拖拽文件到此处）。
5. 等上传完成（约 113 个文件，可能要 1–2 分钟）。
6. 页面下方 **`Commit changes`**（提交更改）区域：
   - 第一个输入框填：`feat: dsh-today-eat 0.4.0`
   - 点绿色按钮 **`Commit changes`**。

## 第 3 步：检查根目录

回到仓库首页，确认直接能看到：

```text
package.json
cordis.patch.yml
README.md
lib/
data/
src/
docs/
assets/
```

如果看到的是一个 `github-upload` 文件夹，说明多套了一层：进这个文件夹，把里面的内容重新按第 2 步上传到仓库根目录（或删除后重传）。

## 第 4 步：添加主题标签

1. 仓库顶部点 **`Settings`**（设置）。
2. 右侧找到 **`Topics`**（主题）。
3. 输入 `dsh-plugin`，按回车。
4. 点 **`Save changes`**（保存更改）。

## 第 5 步：把仓库链接发我

形如：

```text
https://github.com/你的用户名/dsh-today-eat
```

我帮你检查结构、填投稿 YAML，并告诉你下一步怎么提交到社区目录。

## 常见卡住的地方

| 你看到的英文 | 中文意思 | 怎么做 |
| --- | --- | --- |
| `New repository` | 新建仓库 | 点它 |
| `Repository name` | 仓库名 | 填 `dsh-today-eat` |
| `Public` | 公开 | 选中 |
| `Create repository` | 创建仓库 | 点绿色按钮 |
| `uploading an existing file` | 上传已有文件 | 点它 |
| `Drag files here...` | 把文件拖到这里 | 拖 `github-upload` 里的内容 |
| `Commit changes` | 提交更改 | 填说明后点绿色按钮 |
| `Settings` | 设置 | 仓库顶部标签 |
| `Topics` | 主题标签 | 输入 `dsh-plugin` |
| `Save changes` | 保存更改 | 点它 |

> 如果页面和上面不一样，直接把当前页面截图发我，我告诉你点哪里。
