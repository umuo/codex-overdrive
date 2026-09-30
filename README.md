# Codex Monitor App (Codex 桌面版无人值守助手)

这是一款专门为 **Codex Desktop** (基于 ChatGPT 架构) 打造的第三方桌面辅助工具。使用 **Tauri + React + Rust** 构建，拥有原生 macOS 的毛玻璃 (Glassmorphism) UI 设计。

它旨在解决 Codex 用户经常遇到的“5 小时额度限制”和“长任务无人值守”的痛点，帮助你在夜间或离开电脑时，全自动地恢复和推进目标任务。

## 🌟 核心特性

- **⏳ 额度实时监控**
  - 直连本地 `auth.json` 身份凭证，获取云端真实的额度状态和重置倒计时。
  - 动态轮询 (Smart Polling)：在额度受限时，根据距离重置的时间进行 10 秒至 20 分钟的随机轮询；距离重置越近，探测越频繁。

- **🤖 额度恢复后自动续行**
  - 深入读取 Codex 底层 SQLite 数据库 (`thread_history_1.sqlite`)，实时感知 Agent 的执行状态 (`inProgress` 或 `completed`)。
  - 每次启动监控后，首次检测到额度可用就发送一次自定义消息。
  - 后续检测到会话进行中或正常完成，会停止该会话的监控；所有会话停止后自动释放防休眠。
  - 仅当新回合明确因 `usageLimitExceeded` 中断时，才等待额度可用后再次发送并持续检测。普通失败、手动中断不会自动重试。
  - 自带 `TurnID` 记忆防刷屏机制，避免自动监控对同一个回合重复发送消息（记录保存在当前应用内存中）。

- **💬 常用触发语管理系统 (CRUD)**
  - 支持持久化保存常用触发语（如：“继续”、“恢复目标”、“请继续刚才未完成的代码”等）。
  - 支持常用语快捷切换、多行编辑、保存和删除。
  - 会话列表支持搜索、受限目标筛选和批量选择；监控期间锁定配置，停止后可修改。

- **🔧 底层 CLI 极速触发**
  - 放弃脆弱的 UI 自动化测试（如 AppleScript），直接调用 Codex Desktop 内部隐藏的 `codex queue` 命令行工具。
  - **100% 后台静默执行**：无需切换窗口，甚至在 Codex 最小化时也能向特定会话精准注入指令。

- **☕ Caffeinate 防休眠保护**
  - 启动监控后，自动在后台挂载 macOS 的 `caffeinate` 进程。
  - 防止 Mac 在夜间休眠导致网络断开，并在停止监控或退出应用时释放本应用启动的防休眠进程。

## 🚀 快速开始

### 依赖要求
- macOS 系统
- 已安装并登录 Codex Desktop 客户端
- Node.js（20.19+ 或 22.12+）
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

- **Frontend**: React 19, TypeScript, Vite, CSS (Glassmorphism)
- **Backend**: Rust, Tauri
- **System APIs**: macOS `caffeinate`, rusqlite（只读 SQLite）
- **Communication**: Tauri IPC, Codex Internal CLI

## 📝 注意事项

- 本工具直接读取 `~/.codex/` 目录下的数据库和凭证，请确保你的 Codex Desktop 正常安装且具备访问权限。
- 请勿高频手动狂点“测试触发”，合理利用自动监控机制，避免滥用 API 导致账号风控。

## 开发验证

```bash
npm test           # 监控取消、并发与回合去重回归测试
npm run build      # TypeScript 检查与前端构建
cargo check --manifest-path src-tauri/Cargo.toml
```

启动监控后，首次额度可用时发送一次；之后仅重试额度中断。发送后每 30 秒检查回合状态；数据库仍显示发送前的旧回合时继续等待，避免重复发送。会话状态读取失败时记录错误并重试检查，不据此发送。停止监控会阻止后续发送和轮询；已经提交给 CLI 的消息无法撤回。

### 界面预览

运行 `npm run dev` 后，访问 `http://localhost:1420/?demo=1` 可使用示例数据测试界面。预览模式只在开发环境的普通浏览器中生效，不读取凭证或发送真实消息；桌面应用始终使用实际数据。
