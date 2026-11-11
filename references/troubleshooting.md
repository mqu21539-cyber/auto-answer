# 故障排查

## 启动类

### `Chrome not found`

Chrome 只装在机器级路径。确认：

```powershell
Test-Path "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

不在则设 `CHROME_PATH` 指向实际 `chrome.exe`。

### `Chrome did not expose CDP on port 9333 within 20s`

1. 端口被别的程序占了 —— 手动指定：`--port 9334`
2. 有残留的 Chrome 进程锁着 profile：

```powershell
node "$SKILL_DIR\scripts\aa.mjs" stop
Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*Chrome*" } | Stop-Process -Force
```

3. profile 目录损坏 —— 删掉重来（会丢登录态，需重新 `login`）：

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\dsh-auto-answer\chrome-profile"
```

### `CDP socket closed`

Chrome 在任务中途退出。`status` 确认，然后 `start` 重启。`watch` 模式下会因连续失败自动退出（退出码 3）。

## 页面类

### `logged-out` / 跳转到登录页

登录态过期。重跑：

```powershell
node "$SKILL_DIR\scripts\aa.mjs" login <url>
```

### `no-editor` / `no-editor-found`

答题框没找到。先看页面实际结构：

```powershell
node "$SKILL_DIR\scripts\aa.mjs" read
node "$SKILL_DIR\scripts\aa.mjs" shot --out "$env:TEMP\page.png"
```

常见原因：

- 编辑器在 **iframe** 里 —— 当前版本不跨 iframe 注入（跨域 iframe 受浏览器安全策略限制，无法绕过）
- 编辑器懒加载，抓题时还没创建 —— 稍等再 `read`
- 站点改版，class 名变了 —— 看 `shot` 截图，改 `scripts/lib/editor.mjs` 里 `candidates()` 的选择器列表

### `empty-statement`

题面抓出来太短。可能是 SPA 还在加载，或题面在 iframe / shadow DOM 里。重试一次；仍失败就用剪贴板模式（`clip`），完全不依赖读题。

## 注入类

### `ok:false` 且带 `diff`

三级策略全失败。`diff` 会指出第几行、期望什么、实际什么。

| diff 特征 | 含义 | 处理 |
|---|---|---|
| `actualLines` 远多于 `expectedLines`，空行错位 | contenteditable 的空行 `<br>` 计数问题 | 已修；若复现，检查 `readCE()` 是否被页面结构绕过 |
| `actualChars` 明显少于 `expectedChars` | 编辑器有长度上限或拒绝长文本 | 缩短代码，或去掉注释 |
| `line: 1` 且 `actual` 是整段一行 | 换行被吞 | 编辑器把 `\n` 当空格；改用 `--clip` 让用户手动粘贴 |
| 完全空白 | 注入被拦截 | 页面可能有 `beforeinput` 拦截；改用 `--clip` |

### 注入成功但页面「运行」报错

读回一致只证明**文本进了编辑器**，不证明页面把它同步到了内部状态。少数 Monaco 站点需要额外派发 `change` 事件。此时：

1. 用 `--run` 观察页面输出面板
2. 或直接手动改一个字再改回来，触发页面自己的同步

### 编译报错：找不到 `ListNode` / `Solution`

说明**骨架被整段覆盖了**，走了 ACM 模式。检查：

```powershell
node "$SKILL_DIR\scripts\aa.mjs" read   # 看 editorContent 里还有没有 class Solution
```

原因通常是识别失败。加 `--no-merge` 是反方向（强制覆盖），要的是**不要**加它。若识别确实失败，把 `read` 输出的 `editorContent` 发我，我调 `stub.mjs` 的识别规则。

### 方法体写进去了但缩进乱了

`mergeSolution` 按方法头缩进重排。若你的解法里混用了 Tab 和空格，先统一成 4 空格。技能会 dedent 再按方法头缩进重排，但混用仍可能错位。

### 我的解法是完整类/方法，不是方法体

可以直接喂。技能会抽出方法体再拼接。若抽错了（比如类里有多个方法），只保留最后一个方法体——此时改成只写方法体更稳。

### 中文 / emoji 变乱码

`Input.insertText` 走 UTF-8，正常不会乱码。若出现，检查是否用了 `fill`（原样拼进 PowerShell 参数）——改用 `--file`。

## 剪贴板类

### `clipboard write failed`

`Set-Clipboard` 失败，通常是没有交互式会话（比如跑在无桌面的服务里）。确认是普通用户会话下运行。

### 剪贴板内容末尾多/少一个换行

已知坑：`Get-Clipboard -Raw` 会补换行。校验必须用 `.NET Clipboard::GetText()`，`readClipboard()` 已按此实现。

### 通知不弹

Windows 通知需要系统通知权限。`toast()` 失败是**非致命**的，命令仍会成功，同时输出 `\a` 响铃。若需要可靠提醒，看终端输出。

## watch 类

### 切题后没反应

1. 先用 `watch --dry-run` 确认能不能识别
2. 若 dry-run 也没输出，说明 `MutationObserver` 没捕捉到变化——可能整页重渲染。当前实现每次事件后会重新 attach，但若页面在 iframe 里则无法注入
3. 检查是否在 10 分钟去重窗口内（同一个 `sig` 不重复处理）

### `event ignored (busy)`

上一题还在处理（等答案文件 / 注入中）。串行是设计，避免队列错乱。等它处理完。

### `no answer file for sig xxx within timeout`

`--solver agent` 模式下，需要在 `%LOCALAPPDATA%\dsh-auto-answer\answers\<sig>.py` 放答案文件，`sig` 取自 `question-detected` 事件。超时默认 180 秒，可用 `--answer-timeout` 调整。

### 连续两题失败后退出（退出码 3）

设计如此：绝不「乱塞一气」。看最后一次的 `diff` 或错误，修好再重启 watch。

## 自查检测

要验证自己的站点能不能识别出这个浏览器：

```powershell
node "$SKILL_DIR\scripts\aa.mjs" probe --url https://your-site.example
```

输出 `summary` 里每个 `true` 都是页面能观测到的自动化特征，`likelyDetectableAsAutomation` 是汇总判断。这是**诊断**，不做任何伪装。
