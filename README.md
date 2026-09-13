# ChatGPT Web Tools

一份从零实现的 ChatGPT 单站点油猴脚本。它只保留六项阅读/复制与页面清理功能，以及一个很轻的提示词入口，不包含侧栏、会话管理、导出系统、主题系统、框架运行时或远端服务。

脚本文件：[chatgpt-micro-tools.user.js](./chatgpt-micro-tools.user.js)

## 包含什么

- 中文 Markdown 加粗修复：把 ChatGPT 响应中残留的 `**加粗**` 转成 `<strong>`。只替换文本节点，不重写整段 `innerHTML`；代码、公式和正在生成的最后一条响应会跳过。
- 页面加宽：直接调整 ChatGPT 的 `--thread-content-max-width` 和对应容器；可在 760–1440 px 之间调节，对话与输入框保持一致。
- 双击复制公式：从 KaTeX 自带的 TeX annotation 和 `<math>` 读取源代码，可选 LaTeX 或 MathML。
- LaTeX 分隔符：开启后，行内公式自动包成 `$…$`，独立公式自动包成 `$$…$$`；多行独立公式使用换行分隔符。
- 表格复制 Markdown：只在助手响应的表格右上角放一个轻量复制按钮；复制时补齐表头分隔行、转义竖线并保留公式。
- 隐藏核查提示：直接控制 ChatGPT 当前的 `data-testid="thread-disclaimer"` 源节点，并用中英文原文匹配作为结构变化时的后备。
- 提示词快速选取：粘贴正文即可保存，点选后直接替换 ChatGPT 输入框内容。
- 链接提示词：支持普通文本链接，以及 GitHub `blob` / `raw` 文件链接。指定的私有 `natural-trace-skills` 来源通过 GitHub Contents API 读取；远程提示词每次点选前重新获取，失败时不会悄悄使用旧缓存。
- Markdown 锚点导入：例如 `.../SKILL.md#task` 会只导入 `Task` 标题以下、下一个同级或更高级标题以前的内容；也支持 `#L12-L30` 行号范围。
- 极简浮层：右下角 42 px 入口，离开后 900 ms 自动收起；使用 Shadow DOM 隔离样式，跟随 ChatGPT 明暗主题并尊重“减少动态效果”。

## 安装到 macOS 与 Windows

两端安装的是同一个文件，没有 macOS/Windows 分支，也没有平台路径依赖。

1. 在 Chrome、Edge 或 Firefox 安装 Tampermonkey（Violentmonkey 也兼容脚本所用的传统 GM API）。
2. 登录 GitHub 后，从 [最新 Release](https://github.com/feixqemn/chatgpt-web-tools/releases/latest) 下载附件 `chatgpt-micro-tools.user.js`，拖入油猴管理面板并确认安装。不要下载 Source code 压缩包。也可以直接打开[自动更新安装地址](https://gist.githubusercontent.com/feixqemn/1a173d4e6338798008d28297bf8475f6/raw/chatgpt-micro-tools.user.js)。
3. 此后由脚本元数据中的 `@updateURL` / `@downloadURL` 让油猴管理器自动获取新版本，不再拖放本地文件。
4. 刷新 `https://chatgpt.com/`。

设置、本地提示词和 GitHub Token 保存在各浏览器自己的油猴隔离存储中，不会假装已经做了跨设备数据库同步。链接提示词以 URL 为唯一来源：两端保存同一个 GitHub 链接后，每次选用都会读取最新内容，因此提示词正文不需要手动在两端复制。建议 macOS 和 Windows 分别创建一个 Token，方便单独撤销。

自动更新源是一个不在 GitHub 个人主页公开列出的 Secret Gist，但为保证油猴管理器无需 GitHub 登录即可读取，持有更新地址的人仍能查看脚本源码。源码不包含 GitHub Token 或提示词数据。

源码仓库及 Release 为私有；自动更新继续使用已有 Secret Gist。安装附件已内置更新地址，保持油猴的脚本更新检查开启即可。更新检查遵循管理器的检查周期，并非发布后立即推送。脚本元数据保留原名称“ChatGPT 微工具”，以便覆盖旧版并保留设置，页面内标题为“ChatGPT Web Tools”。

## 发布新版本

提升脚本的 `@version`，提交并推送后，以同一份 `.user.js` 创建 Release 并更新现有 Gist：

```sh
gh release create v版本号 chatgpt-micro-tools.user.js --repo feixqemn/chatgpt-web-tools --title 'v版本号' --notes '本次变更说明'
gh gist edit 1a173d4e6338798008d28297bf8475f6 --filename chatgpt-micro-tools.user.js chatgpt-micro-tools.user.js
```

## 链接提示词怎么用

打开右下角入口，切到“提示词”，点“导入”，然后粘贴正文或链接。

示例：

```text
https://github.com/feixqemn/natural-trace-skills/blob/main/natural-trace-web/SKILL.md#task
```

处理过程是：

```text
GitHub blob URL
  → 私有目标改走 api.github.com Contents API
  → 使用只读 Token 获取最新纯文本
  → 查找 GitHub 风格的 #task 标题锚点
  → 截取该 Markdown 章节
  → 本地缓存并填入 ChatGPT
```

`#task` 是浏览器锚点，不会被发送给 GitHub；脚本先读取完整文件，再在本地严格截取 `## Task` 到下一个同级或更高级标题之间的内容。对于这个固定私有来源，缺少 `#task` 的链接会直接拒绝导入。

### 私有仓库授权

1. 在 GitHub 创建 Fine-grained Personal Access Token。
2. Repository access 只选择 `natural-trace-skills`。
3. Repository permissions 只开启 `Contents: Read-only`；不要使用本机 `gh` CLI 那枚权限更大的 Token。
4. 打开微工具的“提示词”，点击钥匙按钮，在本地粘贴 `github_pat_…`，然后点“保存并验证”。
5. 脚本只有在成功读取目标文件并找到 `## Task` 后才保存 Token。

Token 不会写入 `.user.js`、提示词数据或 URL，也不会显示完整值。它只会随以下固定请求发送：

```text
GET https://api.github.com/repos/feixqemn/natural-trace-skills/
    contents/natural-trace-web/SKILL.md?ref=main
```

请求使用 `application/vnd.github.raw+json`，GitHub 官方说明该 Contents API 支持 Fine-grained PAT，所需权限是 `Contents: read`：[REST API endpoints for repository contents](https://docs.github.com/en/rest/repos/contents)。

## 权限边界

- `GM_getValue` / `GM_setValue`：保存功能开关、提示词，以及与普通状态分开的私有 GitHub Token。Token 没有 `localStorage` 回退。
- `GM_setClipboard`：在浏览器 Clipboard API 不可用时复制公式或表格。
- `GM_xmlhttpRequest` + `@connect *`：读取用户亲自粘贴的文本链接。脚本不会后台轮询，也不会请求未保存的地址；远程请求只发生在导入、手动刷新或点选远程提示词时。
- 脚本只匹配 `https://chatgpt.com/*`，不注入其他网站，不加载第三方 JavaScript、字体或样式。

如果只需要 GitHub 链接，可把元数据里的 `@connect *` 改成以下三行，以缩小安装权限：

```javascript
// @connect      github.com
// @connect      raw.githubusercontent.com
// @connect      api.github.com
```

## 从 Ophel Atlas 借鉴了什么、删掉了什么

借鉴的是浏览器页面本身已经提供的几个事实，而不是它的 UI 或架构。对应参考入口是 Ophel Atlas 的 [Markdown fixer](https://github.com/urzeye/ophel/blob/main/src/core/markdown-fixer.ts)、[copy manager](https://github.com/urzeye/ophel/blob/main/src/core/copy-manager.ts)、[ChatGPT adapter](https://github.com/urzeye/ophel/blob/main/src/adapters/chatgpt.ts)、[prompt import UI](https://github.com/urzeye/ophel/blob/main/src/components/PromptsTab.tsx) 和 [中文更新记录](https://github.com/urzeye/ophel/blob/main/CHANGELOG.zh-CN.md)。

| 功能 | Ophel Atlas 的有效机制 | 本脚本的取舍 |
| --- | --- | --- |
| 加粗修复 | 扫描助手段落，把残留的 `**…**` 变为 `<strong>` | 不写回段落 `innerHTML`；仅替换命中的文本节点，关闭开关时可还原 |
| 页面加宽 | 针对 ChatGPT 的 thread content 容器生成 `max-width` CSS | 直接控制同一个 CSS 变量和两个必要的容器选择器 |
| 公式复制 | 事件委托；从 KaTeX annotation 读 LaTeX，从 `<math>` 序列化 MathML | 只做 ChatGPT，不保留多站点 adapter、转换器和平台能力层 |
| 表格复制 | 观察表格、插入按钮、逐行生成 Markdown | 和加粗共用一个 MutationObserver，不做定时轮询或 Shadow DOM 全站扫描 |
| 提示词导入 | JSON 文件校验，再选择合并或覆盖 | 去掉 JSON schema、合并弹窗和分类系统；输入框自动识别正文或 URL，URL 按地址更新 |

Ophel Atlas 的更新记录也说明，整段重写 `innerHTML` 曾破坏站点原生事件绑定。这正是本脚本把修复粒度缩到文本节点的原因。

## 当前边界

- 只支持 ChatGPT 网页端，不尝试兼容 Gemini、Claude 等站点。
- 公式复制依赖页面实际保留 KaTeX/MathML 源码；没有源码时不会根据视觉结果猜公式。
- GitHub `blob` 链接按常见的单段分支名解析；分支名本身包含 `/` 时，请改用 GitHub 的 Raw 链接。
- 表格以第一行作为 Markdown 表头；复杂 `rowspan` 不做视觉布局推断，`colspan` 会补空列。
- 本版本未运行测试流程；这是遵循当前工作区“只有明确要求测试时才在最后测试”的规则，而不是测试通过声明。

## 版本

- `0.3.1`：建立私有源码仓库及可直接安装的 Release 附件，保留已有油猴自动更新地址。
- `0.3.0`：精简标题区与底部文案，增加核查提示开关；固定功能面板高度并只让提示词列表滚动，提示框宽度与面板一致；增加跨平台原生自动更新源。
- `0.2.0`：增加固定私有 GitHub 来源的最小权限授权、保存时验证，以及强制 `#task` 截取。
- `0.1.0`：首版，全新单文件实现。
