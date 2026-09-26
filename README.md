# Codex Monitor App (Codex 桌面版无人值守助手)

这是一款专门为 **Codex Desktop** (基于 ChatGPT 架构) 打造的第三方桌面辅助工具。使用 **Tauri + React + Rust** 构建，拥有原生 macOS 的毛玻璃 (Glassmorphism) UI 设计。

它旨在解决 Codex 用户经常遇到的“5 小时额度限制”和“长任务无人值守”的痛点，帮助你在夜间或离开电脑时，全自动地恢复和推进目标任务。

## 🌟 核心特性

- **⏳ 额度实时监控**
  - 直连本地 `auth.json` 身份凭证，获取云端真实的额度状态和重置倒计时。
  - 智能防风控 (Smart Polling)：在额度受限时，模拟人类操作习惯进行 5~20 分钟的随机轮询，距离解封越近探测越快，防止被官方 API 拦截封号。

- **🤖 无人值守自动连点 (Auto-Loop)**
  - 深入读取 Codex 底层 SQLite 数据库 (`thread_history_1.sqlite`)，实时感知 Agent 的执行状态 (`inProgress` 或 `completed`)。
  - 在额度充足的前提下，只要检测到 Agent 处于空闲/等待状态，程序会立刻自动下发自定义触发消息。
  - 自带 `TurnID` 记忆防刷屏机制，确保同一个回合绝不多发一次消息。

- **💬 常用触发语管理系统 (CRUD)**
  - 支持持久化保存常用触发语（如：“继续”、“恢复目标”、“请继续刚才未完成的代码”等）。
  - 支持下拉框快速切换、随时修改和一键删除。

- **🔧 底层 CLI 极速触发**
  - 放弃脆弱的 UI 自动化测试（如 AppleScript），直接调用 Codex Desktop 内部隐藏的 `codex queue` 命令行工具。
  - **100% 后台静默执行**：无需切换窗口，甚至在 Codex 最小化时也能向特定会话精准注入指令。

- **☕ Caffeinate 防休眠保护**
  - 启动监控后，自动在后台挂载 macOS 的 `caffeinate` 进程。
  - 防止 Mac 在夜间休眠导致网络断开，并在停止监控后优雅释放系统资源。

## 🚀 快速开始

### 依赖要求
- macOS 系统
- 已安装并登录 Codex Desktop 客户端
- Node.js (v18+)
- Rust & Cargo (最新版)

### 安装与运行

1. 克隆代码仓库：
   ```bash
   git clone <你的仓库地址>
   cd codex-monitor-app
   ```

2. 安装前端依赖：
   ```bash
   npm install
   ```

3. 启动开发服务器：
   ```bash
   npm run tauri dev
   ```

4. 构建发布版本：
   ```bash
   npm run tauri build
   ```

## 🛠️ 技术栈

- **Frontend**: React 18, TypeScript, Vite, CSS (Glassmorphism)
- **Backend**: Rust, Tauri
- **System APIs**: macOS `caffeinate`, SQLite CLI
- **Communication**: Tauri IPC, Codex Internal CLI

## 📝 注意事项

- 本工具直接读取 `~/.codex/` 目录下的数据库和凭证，请确保你的 Codex Desktop 正常安装且具备访问权限。
- 请勿高频手动狂点“测试触发”，合理利用自动监控机制，避免滥用 API 导致账号风控。
