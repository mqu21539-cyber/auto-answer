# auto-answer

按下快捷键 → 截取屏幕 → 视觉模型读题并写出代码 → **本地跑一遍页面上的样例** → 通过才放进剪贴板。

零第三方依赖，只用 Node 内置模块。不需要浏览器插件，不需要自动化框架，不需要先配置浏览器。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [它是怎么工作的](#它是怎么工作的)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [日常使用](#日常使用)
- [样例自检（核心机制）](#样例自检核心机制)
- [可靠性设计](#可靠性设计)
- [命令参考](#命令参考)
- [事件流](#事件流)
- [项目结构](#项目结构)
- [测试](#测试)
- [故障排查](#故障排查)
- [已知限制](#已知限制)
- [使用边界](#使用边界)
- [许可证](#许可证)

---

## 它解决什么问题

在线评测/笔试的题目往往很长，规则密集，读题比写代码更费时间。这个工具做三件事：

1. **看屏幕** —— 用截图识别题面，不依赖网页结构
2. **写代码** —— 交给多模态模型
3. **自己验一遍** —— 把模型读到的样例在本地跑一遍，对不上就重做，还不对就**拒绝交付**

第三点最关键：**它不会把一份「看起来像答案」的错误代码塞给你。** 拿不到能通过样例的代码时，剪贴板保持为空。

---

## 它是怎么工作的

```
按 Ctrl+Alt+J
      │
      ├─ 清空剪贴板            ← 防止你过早粘贴，粘到上一题的答案
      │
      ├─ 截取整个屏幕           ← PowerShell + System.Drawing
      │
      ├─ 发给多模态模型         ← OpenAI 兼容接口
      │     返回：代码 + 它读到的样例（JSON）
      │
      ├─ 本地运行代码，喂样例输入
      │     ├─ 全部对上 ────────────→ 写入剪贴板
      │     └─ 对不上 ──→ 把「期望值/实际值」反馈给模型重做（默认最多 3 次）
      │                        └─ 仍不对 ──→ 拒收，剪贴板保持空
      │
      └─ 你按 Ctrl+V 粘贴
```

**为什么用截图而不是读 DOM**：不依赖页面结构。编辑器在 iframe 里、题面是图片、站点布局陌生、甚至题目只是一张静态图片——都不影响，因为输入的是一张图。

**同时保留浏览器模式**：也可以通过 CDP 连接（或启动）Chrome，读 DOM、注入编辑器、读回校验。见 [命令参考](#命令参考)。

---

## 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | **Windows**（截图依赖 `System.Drawing`，热键依赖 `GetAsyncKeyState`，剪贴板依赖 .NET） |
| Node.js | **≥ 22**（需要原生 `fetch` 与 `WebSocket`） |
| 多模态模型 | 任意 OpenAI 兼容接口，且模型支持图片输入 |
| 样例自检（可选） | 需要对应的解释器：Python / Node.js / g++ / javac |

无 npm 依赖，不需要 `npm install`。

---

## 安装

```powershell
git clone https://github.com/<你的用户名>/auto-answer.git
cd auto-answer
```

---

## 配置

只需要一次。API key 保存在项目目录之外（`%LOCALAPPDATA%\dsh-auto-answer\solver.json`），**不会被提交进仓库**。

```powershell
node scripts\aa.mjs setup --api-key <你的KEY> `
    --api-base https://api.openai.com/v1 `
    --model gpt-4o
```

`setup` 会先请求 `/models` 校验模型名，名字不存在会直接报错并列出可用模型，避免等到截图时才 404。

查看当前配置：

```powershell
node scripts\aa.mjs solvers
```

优先级：命令行参数 > `solver.json` > 环境变量 `AA_API_KEY` / `AA_API_BASE` / `AA_API_MODEL` > 默认值。

> **模型必须是多模态的**，纯文本模型读不了截图。

### 配置文件

`%LOCALAPPDATA%\dsh-auto-answer\solver.json`

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "model": "gpt-4o",
  "timeoutMs": 120000,
  "maxTokens": 4096,
  "temperature": 0.1
}
```

---

## 日常使用

### 启动

```powershell
node scripts\aa.mjs watch --desktop --auto --no-toast --deadline 60
```

保持这个窗口开着。

### 隐藏启动（无窗口、无任务栏图标）

项目根目录附带两个 Windows 脚本：

| 文件 | 作用 |
|---|---|
| `initial.vbs` | 隐藏启动监听器 |
| `fuckup.bat` | 停止监听器，并清理残留进程 |

双击即可。日志写入 `%LOCALAPPDATA%\dsh-auto-answer\logs\watch.log`。

`abat.bat` 是配置菜单（填 key、换模型、自检），只在改配置时需要。

> 这两个脚本里写死了 `D:\Fraud\auto-answer` 路径。放到别处请自行修改 `skillDir`（vbs）和 `AA`（bat）。

### 每次做题

1. 在任意浏览器 / PDF 阅读器里打开题目
2. 按 **`Ctrl + Alt + J`**
3. 等 15–35 秒
4. 点编辑器 → `Ctrl + A` 全选 → `Ctrl + V`

### 怎么判断结果

| 现象 | 含义 |
|---|---|
| 剪贴板里有代码 | ✅ 已通过样例自检，可以提交 |
| 等了 35 秒剪贴板还是空的 | ❌ 这题没做出来（或超时），别反复按 |
| 日志出现 `verify-result ok:false` | 样例对不上，正在自动重做 |
| 日志出现 `answer-rejected` | 重做多次仍不过，已放弃 |

**没有通知**（`--no-toast`）。剪贴板空着本身就是信号。

---

## 样例自检（核心机制）

模型会同时返回**代码**和它从页面读到的**样例输入/输出**：

```json
{
  "mode": "acm",
  "language": "python",
  "samples": [
    { "input": "1 2", "output": "3" },
    { "input": "-5 8", "output": "3" }
  ],
  "code": "import sys\n..."
}
```

然后本地执行代码，逐个比对：

| 情况 | 行为 |
|---|---|
| 全部样例通过 | 写入剪贴板，日志 `verified: true` |
| 有样例不通过 | 把「样例 N 期望 X、实际 Y」反馈给模型，重新求解（`--verify-attempts`，默认 3 次） |
| 重做后仍不通过 | **拒收**，剪贴板保持空，日志 `answer-rejected` |
| 代码编译/运行失败 | 把编译器报错反馈给模型重做 |
| 页面无样例 / 核心代码模式 / 语言无解释器 | 照常投递，日志标 `verified: false` 并说明原因 |

支持自检的语言：

| 语言 | 自检 |
|---|---|
| Python | ✅ |
| JavaScript / TypeScript | ✅ |
| C / C++ | ✅ |
| Java | ✅ |
| 其他（Go、Rust、Kotlin…） | ❌ 标记「未验证」后照常投递 |

### 输出比对规则

模拟判题机的宽容度：

- 换行符统一（CRLF → LF）
- 去掉每行行尾空白
- 去掉首尾空行
- **其余格式差异都算错**（题面要求几位小数就必须几位）

### 为什么要这一步

同一张截图让四个不同的模型做同一道题，四个都给出相同的错误结果——因为**题面被一致地理解错了**。模型强弱解决不了这个问题，只有拿样例当裁判才行。

自检把「模型可能读错规则」从**静默错误**变成了**明确的失败**。

---

## 可靠性设计

这套流程有六处天然容易出错，都有对应机制：

| 问题 | 机制 |
|---|---|
| **粘得太早**：答案要 15–35 秒才到，中途粘贴会粘到上一题 | 按键时**先清空剪贴板**。过早粘贴什么都不会粘上，是个诚实的信号 |
| **答案错误**：模型读错规则仍返回像样的代码 | **样例自检**，不过就不投递 |
| **剪贴板被占用**：输入法、截图工具、剪贴板管理器持有它 | **自动重试** 1s → 2s → 4s → 每 30s，最多 10 次。只有**写入并读回一致**才算成功 |
| **换题后旧答案覆盖新答案** | 每次按键递增流水号，旧请求**立即作废**，不再碰剪贴板 |
| **模型返回时已换题** | 代码照写磁盘留底，但**不投递**，日志标 `stale` |
| **网关 429 / 5xx** | **自动重试** 2s → 5s → 10s，受 `--deadline` 总预算约束；401/403/404 立即失败 |
| **热键监听器崩溃** | **2 秒后自动重启**，最多 5 次；连续失败则写好日志后退出 |
| **监听器被强杀留孤儿进程** | 子进程检测到父进程消失后**自行退出** |

### 边界情况

- 重试期间你能继续按 `Ctrl+Alt+J`，新请求立即接管
- 被作废的答案文件留在 `answers/` 里，日志给出补救命令
- `--deadline` 是**总预算**，包含所有重试与重做

---

## 命令参考

| 命令 | 说明 |
|---|---|
| `watch --desktop --auto` | 桌面截图 + 自动求解（**主要用法**） |
| `watch --desktop` | 只截图，等外部写入答案文件 |
| `watch --hotkey <组合> --vision --url <站点>` | 通过 CDP 截整页（需能连上浏览器） |
| `watch --queue` | 只抓题入队，不求解 |
| `setup --api-key <key>` | 保存模型凭据（含模型名校验） |
| `solvers` | 显示当前求解器配置 |
| `stop-watch` | 停止所有监听器进程 |
| `clip --file <路径>` | 把任意文件写入剪贴板 |
| `answer --file <路径>` | 注入浏览器编辑器并读回校验 |
| `prepare --url <地址>` | 抓取当前题目信息（JSON） |
| `selftest` | 自检：三种编辑器注入 + 读回 |
| `grab` | 读取任意页面：题面 + DOM 文本 + 截图 |
| `probe` | 报告页面能看到的自动化检测信号 |
| `start` / `status` / `stop` | 浏览器实例管理 |

完整参数：`node scripts\aa.mjs --help`

### 常用参数

| 参数 | 说明 |
|---|---|
| `--deadline <秒>` | 单次求解总时间上限（默认 60），**包含重试与重做** |
| `--verify-attempts <n>` | 样例不过时重做的次数（默认 3） |
| `--no-toast` | 关闭所有通知与提示音 |
| `--keep-clipboard` | 截图时不清空剪贴板 |
| `--lang <语言>` | 强制输出语言（默认跟随屏幕上的编辑器） |
| `--model <名称>` | 覆盖配置里的模型 |
| `--trigger-file <路径>` | 用写入文件代替按键触发（便于脚本化与测试） |
| `--max <n>` | 投递 n 次后自动停止 |

---

## 事件流

监听器向 stdout 输出 JSONL（每行一个 JSON 对象），便于管道处理：

| 事件 | 含义 |
|---|---|
| `clipboard-cleared` | 截图前清空剪贴板 |
| `vision-request` | 截图完成，等待求解 |
| `solve-retry` | 网关繁忙，正在重试 |
| `verify-result` | 样例自检结果（含 `ok` / `samples`） |
| `answer-retry` | 自检未过，正在重做 |
| `solve-ready` | 模型返回；含 `verified`、`stale`、`solveAttempts` |
| `answer-rejected` | 自检多次未过，**未投递** |
| `solve-failed` | 求解失败（超时、鉴权等） |
| `clipboard-copied` | 已写入剪贴板；`attempts` 为重试次数 |
| `clipboard-retry` / `clipboard-failed` | 剪贴板写入重试 / 放弃（含补救命令） |
| `superseded` | 该请求被更新的按键作废 |
| `hotkey-dead` | 监听器无法维持，进程即将退出 |

---

## 项目结构

```
auto-answer/
├── SKILL.md                  技能说明（DSH 技能入口）
├── DESIGN.zh-CN.md           设计文档与取舍理由
├── README.md                 本文件
├── references/
│   └── troubleshooting.md    故障排查
├── assets/
│   ├── mock.html             测试用模拟页面
│   ├── mock-core.html        核心代码模式模拟页面
│   └── mock-acm.html         ACM 模式模拟页面（含样例，用于验证自检）
├── agents/
│   └── openai.yaml           技能清单
└── scripts/
    ├── aa.mjs                命令行入口
    ├── selftest.mjs
    ├── lib/                  20 个模块
    │   ├── screen.mjs        桌面截图
    │   ├── vision-solver.mjs 模型调用、JSON 解析、重试编排
    │   ├── verify.mjs        样例自检（执行 + 比对）
    │   ├── clipboard.mjs     剪贴板写入 / 清空 / 读回校验
    │   ├── hotkey.mjs        全局热键监听与自愈
    │   ├── chrome.mjs        浏览器查找与启动
    │   ├── cdp.mjs           DevTools Protocol 客户端
    │   ├── editor.mjs        编辑器探测与注入
    │   ├── stub.mjs          核心代码模式脚手架合并
    │   ├── classify.mjs      题目页判定
    │   ├── identity.mjs      题目去重
    │   ├── extract.mjs       题面提取
    │   └── lang.mjs          语言识别（19 种）
    └── test-*.mjs            29 个测试套件
```

---

## 测试

所有测试输出 `{"ok": true}` 表示通过。

```powershell
# 不需要浏览器的单元测试
node scripts\test-lang.mjs
node scripts\test-stub.mjs
node scripts\test-identity.mjs
node scripts\test-classify.mjs

# 求解器与自检（桩服务器，不需要 API key）
node scripts\test-vision-solver.mjs
node scripts\test-solve-retry.mjs

# 桌面全链路（桩模型，不需要 API key）
node scripts\test-auto.mjs
node scripts\test-silent.mjs
node scripts\test-supersede.mjs
node scripts\test-clip-retry.mjs
node scripts\test-hotkey-heal.mjs

# 需要浏览器的
node scripts\aa.mjs selftest
node scripts\test-core-e2e.mjs
```

或一次跑完：

```powershell
npm run test:unit
npm run test:solver
npm run test:desktop
```

> ⚠️ 测试会启动自己的监听器，**单实例保护会杀掉正在运行的监听器**。跑完记得重新启动。
>
> 测试也会写入真实剪贴板，但会在结束时**还原原内容**。`test-lang-guard` 会清空 `answers/` 目录，同样会还原。

---

## 故障排查

日志位置：`%LOCALAPPDATA%\dsh-auto-answer\logs\watch.log`

| 现象 | 排查 |
|---|---|
| 按组合键完全没反应 | 日志最后有无 `armed`。有 → 热键被其他软件占用，换组合键（`--hotkey CTRL+ALT+K`） |
| 剪贴板一直是空的 | 找 `verify-result` / `answer-rejected` / `solve-failed` |
| `answer-rejected` | 样例对不上，模型做不出这题。别反复按 |
| `HTTP 401` / `403` | key 失效，重新 `setup` |
| `HTTP 429` | 网关限流，已在自动重试；持续失败说明服务商拥堵 |
| `request timed out` | 网关太慢。可加大 `--deadline`，或换 key |
| 提示 `Node.js not found` | 改 `initial.vbs` 里的 `nodeExe` 路径 |
| 编辑器内容被旧代码干扰 | 已通过提示词处理；若仍发生，先清空编辑器再按键 |

更多见 [references/troubleshooting.md](references/troubleshooting.md)。

---

## 已知限制

- **只支持 Windows**。截图依赖 `System.Drawing`，热键依赖 `GetAsyncKeyState`，剪贴板依赖 .NET。
- **必须联网**。求解需要调用外部模型接口。
- **不建议连按**。每次按键都是一次完整的截图 + API 请求，连按会撞上接口并发限制。
- **桌面截图只截主屏**。多显示器时若题目在副屏，截到的是主屏内容。
- **截图不自动清理**。`shots/` 目录持续增长（约 1 MB/天）。
- **题面歧义时仍会失败**。样例自检能拦住错误答案，但不能让模型理解它读不懂的规则。
- **核心代码模式无法自检**（需要判题环境才能运行）。

---

## 使用边界

本项目**不做**以下事情，相关请求会被拒绝：

- 伪装浏览器指纹（`navigator.webdriver`、`visibilityState`、`hasFocus`、UA、WebGL 渲染器）
- 绕过切屏检测、录屏检测、焦点检测
- 读取 cookie / 密码 / token
- 默认自动提交答案

切屏检测是监考系统判断「答题者是否在场」的信号，伪装它等同于冒充本人在场。工具提供的是「读题 + 写码 + 自检 + 投递剪贴板」，**是否使用、用在什么场景，由使用者自己负责**。

在线测评、笔试、认证考试通常明确禁止使用辅助工具。请确认你的使用场景允许再使用。

---

## 许可证

[MIT](LICENSE)