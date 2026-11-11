---
name: auto-answer
description: Capture the screen on a global hotkey, solve the coding problem in the screenshot with a multimodal model, and put the code on the clipboard (Windows, Node >= 22). Also able to drive a hidden headless Chrome, read a question from the DOM, and inject a solution into the answer box with read-back verification. Use when the user asks to auto-answer a coding problem, solve what is on screen, copy a solution to the clipboard from a live page, or control Chrome in the background.
---

# auto-answer

后台控制 Google Chrome（`--headless=new`，无窗口），读题 → 写码 → 注入答题框并读回校验，或把答案复制到剪贴板由用户自己粘贴。

零 npm 依赖：Node 原生 `WebSocket` + `fetch` 直连 Chrome DevTools Protocol。

## 边界（先读）

**做**：无窗口启动 Chrome、抓题面/样例/编辑器类型、注入代码、读回逐字符校验、监听换题、写系统剪贴板、弹通知。

**不做**：反检测伪装（伪造 `navigator.webdriver`、`visibilityState`、`hasFocus`、UA、WebGL 指纹）。切屏检测是监考系统判断「人是否在场」的信号，伪装它等于冒充本人在场答题。若用户要求绕过，说明边界并提供替代方案（`probe` 自查检测是否触发；或抓题到对话里讲，用户不必切屏）。

**不做**：读取 cookie / 密码 / token；默认自动提交。

## 快速开始

`SKILL_DIR` = 本 `SKILL.md` 所在目录。所有命令用绝对路径，不要 `cd`。

```powershell
$aa = "$SKILL_DIR\scripts\aa.mjs"
```

### 1. 首次登录（一次性，有头）

```powershell
node $aa login https://your-site.example/problem/1
```

会弹出可见窗口，**用户手动登录**，登录完在终端按回车。cookie 存进专用 profile，之后全程无头复用。

### 2. 单题流程

```powershell
# 抓题：返回 JSON（题面、样例、语言、编辑器类型）
node $aa prepare --url https://your-site.example/problem/1

# 写解法到 solution.py，本地用样例验证
python solution.py   # 或写测试脚本喂样例

# 方式 A：注入 + 校验
node $aa answer --file solution.py

# 方式 B：只复制到剪贴板，用户自己 Ctrl+V
node $aa clip --file solution.py
```

`answer` 成功返回 `{"ok":true,"editor":"monaco","chars":842,"attempts":[...]}`；失败返回 `diff`（第几行、期望值、实际值）并退出码 3。

### 3. 热键模式（推荐）

按 **J+K** 才开始识别，其他按键和日常浏览都不触发。

```powershell
node $aa watch --hotkey J+K --url <你的站点>
```

按下 J+K 之后：

| 时刻 | 事件 |
|---|---|
| 立刻 | 识别当前题目 → **第 1 次通知**（已识别到题目） |
| 3 秒后 | 答案进剪贴板 → **第 2 次通知**（可以粘贴了） |

每题最多 2 次通知，两次间隔至少 60 秒。

热键模式默认开启剪贴板投递；`--clip-delay` 可调第 2 次通知的延迟（默认 3 秒）。

### 4. 桌面截屏 + 自动求解（完全无人值守，静默）

**不启动浏览器、不需要调试端口、不弹任何通知。** 按下组合键后什么都不用做，等 30 秒内看剪贴板即可。

```powershell
# 一次性配置（key 存到 %LOCALAPPDATA%\dsh-auto-answer\solver.json）
node $aa setup --api-key <你的key> --api-base https://api.deepspacecode.cn/v1 --model gpt-6-astra

# 之后日常只用这条
node $aa watch --desktop --auto --no-toast --deadline 30
```

按 **`Ctrl + Alt + J`** 之后：

| 时刻 | 发生什么 |
|---|---|
| 立刻 | 截全屏（无任何提示） |
| 3–15 秒 | 视觉模型读图 → 写出完整代码 → 写进 `answers/<sig>.<ext>` |
| 之后 | 内容进剪贴板 |

**没有通知。** 你按完就开始等，`Ctrl+V` 时剪贴板里已经有答案。

`--deadline 30` 是硬上限：模型超过 30 秒没返回就放弃该次请求，不会无限挂着。

`--no-toast` 同时关闭提示音。

### 求解器配置

`solver.json`（`setup` 命令自动生成）：

```json
{
  "baseUrl": "https://api.deepspacecode.cn/v1",
  "apiKey": "sk-...",
  "model": "gpt-6-astra",
  "timeoutMs": 120000,
  "maxTokens": 4096,
  "temperature": 0.1
}
```

任何 OpenAI 兼容端点都能用（官方、中转、本地 Ollama/vLLM）。`setup` 会先查 `/models` 校验模型名，填错直接拒绝并列出可用模型。

检查当前配置：

```powershell
node $aa solvers
```

优先级：命令行参数 > `solver.json` > 环境变量 `AA_API_KEY` / `AA_API_BASE` / `AA_API_MODEL` > 默认值。

模型必须是**多模态**的（能看图），否则无法读截图。

#### 可靠性保证

这条链路有三处容易出错，都有对应机制：

| 情况 | 行为 |
|---|---|
| 剪贴板被别的程序占用（输入法、截图工具、剪贴板管理器） | **自动重试**：1s → 2s → 4s → 每 30s，最多 10 次。只有写入**并读回一致**才算成功 |
| 重试期间你换题又按了一次 | 旧请求**立即作废**，不再碰剪贴板；答案文件保留在磁盘 |
| 模型算完时你已经换题 | 文件照写，但**不投递**，日志记 `stale` |
| 热键监听器崩溃（杀软、系统更新） | **2 秒后自动重启**，最多 5 次；连续失败则退出并留日志 |
| 10 次重试都失败 | 日志给出完整补救命令 `node aa.mjs clip --file "..."` |

**为什么「换题作废」是必须的**：单独加重试会出现「你已经在看 B，A 的重试 30 秒后成功，把 A 的答案塞进剪贴板」，一按 `Ctrl+V` 就粘错题。所以每次按键都会把更早的待办作废。

相关事件（stdout JSONL）：

| 事件 | 含义 |
|---|---|
| `superseded` | 该请求被更晚的一次按键作废 |
| `clipboard-retry` | 写入失败，N 毫秒后重试（含 `attempt` / `error`） |
| `clipboard-failed` | 已达重试上限，含 `recover` 字段给出补救命令 |
| `hotkey-dead` | 监听器无法重启，进程随即退出 |

### 4b. 桌面截屏（不自动求解）

不带 `--auto` 时只截图并通知，等外部写入答案文件：

```powershell
node $aa watch --desktop
```

### 5. 整页截图模式（需要接入浏览器时）

和桌面截屏的区别：这个只截**网页**，需要能连上浏览器（调试端口或技能自己启动的实例）。

```powershell
node $aa watch --hotkey J+K --vision --url <你的站点>
```

适合需要排除其他窗口干扰、或浏览器窗口很大的情况。

### 其他监听模式

```powershell
node $aa watch --queue                  # 自动监听 DOM，检测到就入队
node $aa watch --dry-run                # 只验识别，什么都不做
node $aa watch --clip --clip-delay 5    # 自动监听 + 剪贴板
node $aa watch --solver template        # 套内置模板自动出答案
```

`watch` 输出 **JSONL**（每行一个 JSON 事件），事件类型：`hotkey` / `vision-request` / `vision-timeout` / `not-a-question` / `page-captured` / `question-detected` / `queued` / `queue-skipped` / `clipboard-pending` / `clipboard-copied` / `language-mismatch` / `injected` / `submit`。

### 手动兜底：grab

任意页面、任意时刻，一条命令拿到「结构化题目 + 截图 + DOM 文本」：

```powershell
node $aa grab
```

返回 `recognized`、`question`（标题/题面/样例/语言）、`editorContent`、`screenshot`（图片绝对路径）、`domText`。识别失败也有截图可看，不会空手而归。

## 只有题目页面才通知

自动监听（DOM 观察）时，普通页面（题库列表、提交记录、个人中心、登录页、弹窗）**不会**触发通知、不会入队、不消耗配额。

**按 J+K 时例外**：那是你明确要求"看这一页"，所以即使判定为非题目也会截图并通知一次。

自动监听时的判定条件：

| 条件 | 说明 |
|---|---|
| 有答题编辑器 | monaco / codemirror / textarea / contenteditable |
| 题面 ≥ 80 字符（有样例时 ≥ 40） | 排除弹窗、搜索框；短题靠样例兜底 |
| 至少 1 个题目特征词 | 「输入格式」「样例输出」「数据范围」「时间限制」「返回值」等 |
| 综合评分 ≥ 6 | 编辑器 +2，题面长度 +1，特征词最多 +4，样例 +2，标题 +1 |
| 标题含反向词则扣分 | 「提交记录」「全部题目」「个人中心」等**只看标题**，因为真实题目页的标签栏里也有这些词 |

非题目页面输出 `not-a-question` 事件，附带 `reason` 和 `signals`，便于调参。

## 两种题目模式

平台有两类答题框，处理方式完全不同，技能会**自动识别**：

| 模式 | 长什么样 | 怎么处理 |
|---|---|---|
| **ACM 模式** | 编辑器是空的，或已有一段完整程序 | 整个编辑器替换成你的解法 |
| **核心代码模式** | 编辑器里已有 `class Solution` + 方法骨架 + `// write code here` | **只替换方法体**，类名/签名/预置注释全部保留 |

核心代码模式是 LeetCode / 牛客 / 赛码的默认形态。整段覆盖会破坏平台预置的 `ListNode` 类注释和 `Solution` 类，导致编译失败——所以必须切进方法体里写。

### 怎么判断

| 信号 | 判定 |
|---|---|
| 编辑器为空 | ACM |
| 有 `// write code here` / `// 在此编写代码` / `TODO` 标记 | 核心代码 |
| 有 `class Solution` 且方法体为空 | 核心代码 |
| 已存在 `int main()` / `def main()` / `func main()` | ACM |

### 怎么合并

- 只写**方法体**（不含签名）即可，技能会按方法头缩进自动重排
- 也接受**整个方法**或整个类，会自动抽出方法体
- 括号按配对扫描，跳过字符串和注释里的 `{}`
- 闭合 `}` 对齐到方法头缩进
- 类结尾之后的残留字符会被清掉（平台草稿里常混进误按键）
- 加 `--no-merge` 可强制走 ACM 模式（整段覆盖）

`answer` / `watch` 的输出会带 `mode`、`spliced`、`methodHeader` 三个字段，可直接确认走了哪条路。

**截图识别模式下不需要合并**：直接给完整可编译的文件，用户全选粘贴即可。

## 写入方式

Monaco 的写法因站点而异，技能按三级降级：

| 档 | 手段 | 适用 |
|---|---|---|
| 1 | 编辑器原生 API `model.setValue` | 暴露 `monaco.editor` 的站点 |
| 2 | 真实鼠标点击聚焦 → `Ctrl+A` → `Input.insertText` | 隐藏了 `monaco.editor` 的站点（牛客就是这样） |
| 3 | 原生 setter + 派发事件 | textarea / contenteditable |

顺序很重要：**先聚焦，再全选，最后写入**。反过来会把「替换」变成「追加」——真实键盘事件会取消之前的选择。

读取也做了降级：没有 `monaco.editor` 时读 `.view-line` 渲染出来的行，得到的就是用户眼前看到的代码。

## 语言处理

支持 **Python / C++ / C / Java / JavaScript / TypeScript / Go / Rust / C# / Kotlin / Swift / PHP / Ruby / Scala / Haskell / Lua / Perl / R / SQL**。

### 语言从哪来

**题目识别到什么语言，剪贴板里就是什么语言**——这是硬约束，不是建议。

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | 页面语言选择器 | `Python 3`、`C++17 (GCC 9.2)`、`Java (OpenJDK 17)`、`PyPy 3` 等一律归一化到同一 id |
| 2 | `--lang` | 仅当页面**没有**语言选择器时的兜底 |
| 3 | 文件扩展名 | `answer --file` 时用于交叉校验 |
| 4 | 默认 `python` | 以上都没有时 |

### 不一致会怎样

答案文件扩展名与题目语言不符时，**拒绝写入/复制**，并输出 `language-mismatch` 事件：

```json
{"event":"language-mismatch","sig":"1d97cd28","expected":"python","found":"java"}
```

把文件改名成 `answers/<sig>.py` 即可。3 秒后自动重试，不需要重新切题。`answer` 命令加 `--force` 可强制写入（不推荐）。

### 自动切语言

页面上有语言选择器、且当前不是题目要的语言时，**注入前自动切过去**——因为切换会重置编辑器，必须在写入之前完成。

### 一次识别只弹一次通知

每个 `sig` 只弹一次，重试和复制阶段都静默。通知正文默认空白，只作存在感提示；改 `scripts/lib/messages.mjs` 即可定制。

### 一次识别只弹一次通知 / 每题最多两次

通知策略由 `scripts/lib/identity.mjs` 控制，规则：

| 规则 | 值 |
|---|---|
| 每题最多弹通知 | **2 次** |
| 两次通知最小间隔 | **60 秒** |
| 同一题的连续重渲染 | 不弹（判定为同一题） |
| 真正切到新题 | 立即弹 1 次 |

判定「是不是同一题」用两级：

1. **标题完全相同** → 同一题（OJ 的标题就是题目标识；正文区域在两次渲染间可能多带或少带面包屑、meta 行，不可靠）
2. **标题模糊相似 ≥ 0.9 且正文 ≥ 0.8** → 同一题
3. 否则 → 新题

比较前会先剔除噪声：`通过率 32.90%`、`耗时 120ms`、`剩余时间 01:23`、`难度：中等` 这类会跳动的文本。

所以页面上的计时器、通过率刷新、局部重渲染都不会造成重复通知。

可调参数：

```powershell
--max-notify 2          # 每题最多几次通知
--renotify-delay 60000  # 两次通知最小间隔（毫秒）
```

## 浏览器

Chrome 和 Edge 都支持，自动探测已安装的那个（优先 Chrome）。两者都说 CDP，所以逻辑完全一致，只有二进制和 profile 目录不同。

```powershell
node $aa browsers            # 列出已安装的浏览器 + 当前可接入的实例
node $aa attach              # 接入正在运行的浏览器，报告当前标签页和识别结果
```

接入优先级：

| 顺序 | 行为 |
|---|---|
| 1 | `--port` 指定的端口有实例 → 直接接入 |
| 2 | 9222 / 9223 / 9333 / 9444 任一有实例 → 直接接入 |
| 3 | `--daily` → 用你的日常 profile 启动（登录态全在） |
| 4 | 都没有 → 启动独立 profile |

`AA_BROWSER=chrome|edge` 可强制指定。

**接入已有浏览器时不会新开窗口**，读的是你当前正在看的那个标签页。

### 为什么需要调试端口

普通启动的 Chrome/Edge 不暴露 CDP，无法被外部读取。要接入，必须以调试端口启动一次：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
```

注意：日常 profile 已被占用时，浏览器会拒绝调试端口——先关掉所有窗口。或者直接 `--daily` 让技能自己用你的 profile 启动。

## 命令参考

| 命令 | 作用 |
|---|---|
| `start [--show]` | 启动或复用无头 Chrome |
| `status` | 实例状态、端口、当前 URL |
| `stop` | 关闭实例 |
| `login <url>` | 有头登录，cookie 持久化 |
| `prepare [--url]` | 启动 + 导航 + 抓题 |
| `read` | 重读题面与编辑器内容 |
| `probe` | 报告页面能看到的自动化信号（自查检测用） |
| `answer --file <p>` | 注入 + 读回校验 |
| `solve --file <p>` | 合并进页面骨架 + 放剪贴板（不写页面） |
| `pending` | 显示最新检测到、未处理的题目 |
| `queue [--clear]` | 列出（或清空）题目队列 |
| `clip --file <p> [--delay n]` | 复制到系统剪贴板 + 弹通知 |
| `fill <text>` | 只注入不校验（排障） |
| `click <sel\|text>` | 点按钮（按选择器或可见文字） |
| `shot [--out p]` | 截图 |
| `grab` | 任意页面通用读取：题目 + 截图 + DOM 文本 |
| `watch` | 监听换题，见下 |
| `selftest` | 对内置 mock 页验证三种编辑器注入 |

### watch 选项

| 选项 | 说明 |
|---|---|
| `--dry-run` | 只报告检测，不注入 |
| `--hotkey <combo>` | 只在按下组合键时识别，如 `J+K` |
| `--vision` | 截图识别，完全不依赖 DOM（最通用） |
| `--trigger-file <p>` | 外部工具写该文件即触发一次识别 |
| `--queue` | 检测到就存进队列，供 `pending` / `solve` 使用 |
| `--clip` | 检测到 → 通知 → 延时 → 复制到剪贴板 |
| `--clip-delay <s>` | 通知到复制之间的秒数，默认 5 |
| `--solver agent\|template\|"<cmd>"` | 谁写代码：agent 等 `answers/<sig>.<ext>`；template 套模板；cmd 从 stdin 读题面、stdout 出代码 |
| `--max <n>` | 成功 n 题后停止 |
| `--auto-submit` | 注入校验通过后点提交（默认关） |
| `--answer-timeout <s>` | agent 模式等答案文件的秒数，默认 180（vision 模式默认 600） |
| `--retry-delay <ms>` | 失败后重试间隔，默认 3000 |
| `--lang <name>` | 页面无语言选择器时的兜底语言 |

## 工作原理

### 注入：三级降级

1. **编辑器原生 API** —— Monaco `model.setValue()`、CodeMirror `view.dispatch()`。最稳，无副作用。
2. **CDP `Input.insertText`** —— 先 focus + 清空，再整段插入。触发真实 `input` 事件，textarea / contenteditable 走这条。
3. **原生 setter + 派发事件** —— React/Vue 受控组件兜底。

每档之后立刻读回比对（归一化：统一换行、去行尾空白、去尾部空行），一致才算成功；三档全失败就停，不硬塞。

### 换题检测

页面内挂 `MutationObserver` + URL 轮询，用 `Runtime.addBinding` 把事件推给 Node 侧。注入前先置 `selfWriting` 标志，避免自己触发自己。去重窗口 10 分钟。

### 已知坑（都已处理）

- **contenteditable 不能读 `innerText`**：Chrome 把每行包进 `<div>`，空行的 `<br>` 会被重复计数，缩进是 `&nbsp;`。改用逐块 `textContent` 读取 + `\u00a0` 还原。
- **`Get-Clipboard -Raw` 会多一个换行**：校验剪贴板必须用 `.NET Clipboard::GetText()`，否则源码末尾永远对不上。
- **剪贴板写入用 base64 传参**：代码里有引号、反引号、换行、中文，直接拼 PowerShell 字符串会被解析坏。
- **事件流必须是单行 JSON**：多行缩进 JSON 无法被逐行解析，`watch` 强制 JSONL。
- **`JavaScript` 会被误判成 `java`**：语言规则必须按 `TypeScript → JavaScript → Java` 排序，`JavaScript` 里含有 `java` 子串。
- **过期答案文件会被误用**：`answers/<sig>.py` 若早于本次检测就忽略，否则昨天的答案会被注入今天的同一题。
- **去重不能挂在检测上**：拒绝/超时不能锁死 10 分钟去重窗口，只有**成功处理**才记录，否则改完文件也没用。
- **重试不能重新发事件**：重试只重跑答案段，不再发 `question-detected`、不再弹通知，否则一次识别会弹两次。
- **ToastGeneric 不接受空文本节点**：全空白通知会抛异常，改为塞一个空格。
- **核心代码模式不能用 `{` 往前找方法体**：标记注释在方法体**内部**，往前扫会撞上内层语句的 `{`，只截到片段。正确做法是找「匹配 `}` 落在标记之后」的那个 `{`。
- **`\a` 响铃不能写 stdout**：会把 JSONL 事件流污染成非法 JSON，改走 stderr。
- **PowerShell 脚本不能塞进 JS 模板字符串**：`$var` 和 `${...}` 会被 JS 插值吃掉，必须用普通字符串加显式 replace。
- **JS 的 `\W` 会把所有中文当非单词字符**：`/^[\d\s\W]+$/` 会匹配任意纯中文标题，判「数字标题」要显式列字符集。
- **通知计数必须落盘**：watch 重启后清零会让同一题再弹 2 次。状态存 `tracker.json`，只存 body 哈希不存全文。
- **测试之间会共享 tracker 文件**：一套测试弹过的题会让下一套静默失败，每套测试必须用独立 `AA_TRACKER_FILE`。
- **不能只靠正文相似度判断同一题**：题面抓取区域在两次渲染间会多带或少带面包屑、meta 行，相似度可能掉到 0.55。标题是 OJ 自己的题目标识，标题相同即同一题。
- **通知计数不能按「观察次数」累加**：被间隔窗口压掉的那次不该消耗配额，否则 2 次配额会被重渲染白白吃掉。
- **反向证据不能扫整页**：真实题目页的标签栏里也有「提交记录」，扫正文会把真题判成非题目。只看标题。
- **Monaco 聚焦必须用真实鼠标事件**：页面内 `el.focus()` 和合成 `mousedown` 都不算数，必须走 CDP `Input.dispatchMouseEvent`。
- **聚焦顺序不能反**：`prepareFocus()` 会派发合成事件取消选区，必须排在「真实点击 + Ctrl+A」**之前**，否则替换变成追加。
- **没有写 API 的 Monaco 不能改 DOM**：直接 `innerHTML` 会毁掉渲染器，只能全选后覆盖输入。
- **短题会被长度下限误杀**：不少题目两行就说完了，有样例时把题面下限从 80 放宽到 40 字符。
- **类结尾后的残留字符要清掉**：平台会保存误按键（例如 `}j`），留在类外直接编译失败。
- **写答案文件不能带 BOM**：`Set-Content -Encoding UTF8` 会加 BOM，Java 编译报错。用 `[IO.File]::WriteAllText($p,$t,[Text.UTF8Encoding]::new($false))`。
- **桌面截图不能用题目标识去重**：截图这一层拿不到标题和题面，若把空标题空正文喂给模糊匹配，所有截图都会被判成同一题，通知配额瞬间耗尽。每次按键必须独立计数。
- **等答案不能阻塞按键**：`await` 答案文件会让后续按 J+K 全部报 `still busy`。改成「登记待处理 + 后台轮询」。
- **轮询要先抢占再等待**：复制要 1 秒（起 PowerShell），轮询器会在此期间再跑一次，同一份答案被复制两次、弹两次通知。进入复制前先置 `claimed`。
- **`windowsHide: true` 会连 GUI 主窗口一起隐藏**：Windows 上它设置 `STARTF_USESHOWWINDOW=SW_HIDE`，Chrome/Edge 的窗口也跟着不见了。headless 时可以隐藏，非 headless 必须设为 false。
- **强杀浏览器会让 profile 标记为崩溃**：下次启动弹「要恢复页面吗？」气泡挡住窗口。启动前清 `exit_type`，并加 `--disable-session-crashed-bubble --hide-crash-restore-bubble`。
- **普通字母键做全局热键会打进编辑器**：`GetAsyncKeyState` 只观测不吞键，J+K 会被当前焦点控件收下（牛客编辑器里就出现过 `jK`）。默认改用 `Ctrl+Alt+J` 这类不产生字符的组合。
- **求解不能阻塞按键**：调用模型要几秒到几十秒，必须在后台跑，否则后续按键全被丢弃。
- **剪贴板换行是 CRLF**：比较写入内容与读回内容时要统一换行并去首尾空白，否则永远「不一致」。

## 自证

```powershell
node $aa selftest                    # 三种编辑器注入 + 读回
node scripts/test-auto.mjs           # 无人值守全链路：触发 → 截图 → 模型 → 剪贴板 → 通知2
node scripts/test-clip-retry.mjs     # 剪贴板被占用时自动重试（真实锁住剪贴板）
node scripts/test-supersede.mjs      # 换题后旧答案不覆盖新答案
node scripts/test-hotkey-heal.mjs    # 热键监听器崩溃后自动重启 / 放弃时上报
node scripts/test-vision-solver.mjs  # 求解器：代码提取、语言识别、缺 key、HTTP 错误
node scripts/test-desktop.mjs        # 桌面截图：两次触发各自计数、不阻塞、剪贴板一致
node scripts/test-vision.mjs         # 整页截图全链路：触发 → 截图 → 通知1 → 答案 → 剪贴板 → 通知2
node scripts/test-twophase.mjs       # J+K 后两次通知的时序（0ms / +3s）
node scripts/test-hotkey.mjs         # 组合键解析 + 监听器存活
node scripts/test-hotkey-gate.mjs    # 不按键时零通知、零入队
node scripts/test-hotkey-queue.mjs   # 热键识别后题目入队，pending 可读
node scripts/test-classify.mjs       # 10 个页面样本的题目判定
node scripts/test-not-question.mjs   # 题库列表页：0 通知 0 入队
node scripts/test-identity.mjs       # 题目同一性判定 + 通知配额 + 60 秒间隔
node scripts/test-notify-cap.mjs     # 长历史、重启持久化、配额
node scripts/test-notify-restart.mjs # 重启后不重复通知
node scripts/test-notify-policy.mjs  # 真实页面：重渲染不弹、切题才弹、切回不弹
node scripts/test-stub.mjs           # 7 种骨架识别 + Java/Python 合并 + ACM 回退
node scripts/test-core-e2e.mjs       # 真实骨架页面上合并 Java/Python，骨架存活
node scripts/test-switch.mjs         # 连续切 3 道题：新 sig、新题面、语言跟随
node scripts/test-solve-loop.mjs     # watch --queue → pending → solve → 剪贴板可编译
node scripts/test-nosite.mjs         # 不设站点：打开可见窗口并武装热键
node scripts/test-lang.mjs           # 36 个语言标签归一化 + 9 语言模板 + 选择器切换
node scripts/test-lang-e2e.mjs       # 9 种语言逐个切换并注入
node scripts/test-lang-guard.mjs     # 语言一致性拒绝 + 一次识别一次通知
node scripts/test-watch.mjs          # 换题检测 → 复制 → 切题 → 再复制
```

全部返回 `"ok": true` 才算通过。

## 桌面启动器

`D:\Fraud\abat.bat` 双击即用，菜单式操作：

| 键 | 作用 |
|---|---|
| `1` | 首次登录 |
| `2` | 开始监听（推荐流程入口） |
| `3` | 查看刚检测到的题目 |
| `4` | 把答案文件变成剪贴板内容 |
| `5` | 抓取当前题目一次 |
| `6` | 状态 + 队列 |
| `7` | 设置站点地址 |
| `8` | 停止后台浏览器 |
| `9` | 自检 |

也支持 `abat.bat 2` 直接进监听。bat 存为 **GBK + CRLF**（cmd 要求），改完记得保持。

## 状态与路径

- 状态文件：`%LOCALAPPDATA%\dsh-auto-answer\state.json`（pid / port / profile / 当前 target）
- 专用 profile：`%LOCALAPPDATA%\dsh-auto-answer\chrome-profile`（与日常 Chrome 完全隔离）
- 答案暂存：`%LOCALAPPDATA%\dsh-auto-answer\answers\<sig>.py`
- 默认端口 9333，被占自动回退
- Chrome 路径默认 `C:\Program Files\Google\Chrome\Application\chrome.exe`，可用 `CHROME_PATH` 覆盖

## 故障排查

见 `references/troubleshooting.md`。
