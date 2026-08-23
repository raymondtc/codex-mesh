# Codex Remote Web

一个参考 Remodex 交互的移动端优先 Web/PWA：Codex 和仓库留在你的主机上，浏览器通过受限桥接实时查看、继续和审批任务。

## 已实现

- 优先连接本机 Codex daemon，共享已加载线程；不可用时启动 `codex app-server --stdio`
- 任务列表、创建、恢复和完整历史读取
- 原生 Codex Project 管理；未归属任务按工作目录自动分组
- Thread Fork、`/fork`/`/side` 命令和并行侧边聊天
- 原生持久目标（描述、状态、Token 预算、用量和耗时）及 ChatGPT 风格完成胶囊
- 对话搜索、重命名、归档；回复复制与有用/无用反馈
- 实时 assistant delta、命令输出、文件变更、计划和工具卡片
- Unified diff、受限文件浏览、文本和图片预览
- 发送后续指令、选择模型/推理强度、中断正在执行的 turn
- 命令与文件变更审批，以及 `request_user_input` 问答
- 共享 Token 鉴权、WebSocket 负载限制、app-server RPC 白名单
- 响应式布局与 PWA manifest

## 架构

```text
手机 / 桌面浏览器
        │  WSS + shared bearer token
        ▼
Node.js bridge (RPC 白名单 + 审批路由)
        │  WebSocket over Unix socket，或 JSONL over stdio
        ▼
codex app-server ── 本机登录、仓库、沙箱与工具
```

桥接层不允许浏览器任意调用 app-server。MVP 只暴露 thread、turn、model、account 和 project 的少量方法；`fs/*`、`process/*`、插件安装和配置写入默认被拒绝。

## 运行

要求 Node.js 20+ 与已登录的 Codex CLI。当前已在 `codex-cli 0.149.0` 上做过联调。

```bash
cp .env.example .env
npm install
npm run dev
```

开发模式中打开 `http://127.0.0.1:5173`。生产构建：

```bash
npm run build
REMOTE_WEB_TOKEN='your-long-random-token' npm start
```

默认只监听 `127.0.0.1:8787`。如果需要让其他设备访问，建议先用 Tailscale/WireGuard 组网，或者在 Caddy/Nginx 后提供 HTTPS/WSS，然后显式设置：

```bash
HOST=0.0.0.0 \
PORT=8787 \
REMOTE_WEB_TOKEN='at-least-24-random-characters' \
npm start
```

桥接层会自动连接 `~/.codex/app-server-control/app-server-control.sock`（如果 daemon 正在运行），从而与 Codex 桌面端、IDE 或 Remote 共享线程写入者。也可以用 `CODEX_APP_SERVER_URL` 显式指定 `unix://`、`ws://` 或 `wss://` 地址；设置为 `stdio://` 可强制启动隔离的 app-server。

不要把本服务以明文 HTTP 直接暴露到公网。Token 保存在浏览器 `localStorage`，适合个人单用户 MVP，不是多租户身份系统。

## 协议升级

app-server 仍属快速演进的实验性界面。升级 Codex CLI 后可在项目根目录运行：

```bash
npm run protocol:generate
```

这会把当前 CLI 的 TypeScript 协议生成到 `protocol/`（已 gitignore），用于比对方法名与 payload。

## 本机真实 E2E

服务启动后运行以下命令。测试会连接当前 WebSocket Bridge，读取真实 Project/thread/文件，创建并最终归档测试 fork，通过本机 Codex 完成一个最小 turn，并验证 Goal set/get/clear：

```bash
npm run e2e:local
```

如果没有可用的已完成 thread，可以显式设置 `E2E_THREAD_ID`。设置 `E2E_RUN_TURN=0` 可跳过会产生模型调用的 fork/turn 部分。

## 下一阶段

1. 图片/文件附件上传：服务端暂存后转换为 `localImage` / `localAudio` input。
2. Git 状态与提交面板：使用独立、受审批的 Git service，不开放通用 shell RPC。
3. 语音输入与系统通知：PWA Web Push + 浏览器录音。
4. 配对协议：以一次性二维码交换设备密钥，替换共享 Token。
5. 多主机和断线队列：每主机独立身份、持久化转发和通知。
6. 受限 SSH 终端：单独权限与审计记录，不与 Codex RPC 通道混用。
