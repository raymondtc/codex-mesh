# Codex Mesh

Codex Mesh 是一个自托管的 Codex 控制面。用户在浏览器登录后，通过 SSH 管理自己的 Codex 主机、项目和会话；仓库、Codex 登录凭据、沙箱与工具执行仍留在远端主机上。

## 架构

```text
浏览器 ── HTTPS / WSS ──► Codex Mesh Server ── SSH ──► codex app-server --stdio
                              │
                              └──────────────► PostgreSQL / PGlite

NAT 后的主机可以主动建立反向 SSH：

宿主机 OpenSSH ──► Reverse SSH Relay ──盲转发 channel──► Server SSH transport
```

Server 按需建立 SSH 连接并在 channel 内启动 `codex app-server --stdio`，远端无需安装或常驻 Codex Mesh Agent。远端必须能被 Server 通过 SSH 到达；推荐使用 Tailscale/WireGuard 等私有网络，不要把 SSH 直接暴露到公网。OpenAI/Codex 凭据不会上传到控制面。

## 已实现

- Better Auth 邮箱密码注册、登录、HttpOnly Session Cookie 和首用户管理员
- 用户列表与管理员角色管理，用户之间的机器和会话数据隔离
- 默认持久化 PGlite，设置 `DATABASE_URL` 后使用 PostgreSQL；启动时自动迁移
- SSH 主机管理、Ed25519 专用密钥生成、OpenSSH 私钥导入、主机指纹固定和审计事件
- SSH 私钥使用 AES-256-GCM 加密落库，部署主密钥只从环境读取且私钥永不返回前端
- 自动创建个人租户，机器访问必须通过 tenant membership；机器 ID 不能绕过租户授权
- 可选反向 SSH Relay：每台机器独立隧道密钥、不开放可扫描转发端口、每机限制并发 channel
- 按需 SSH channel 直接启动远端 `codex app-server --stdio`，无需宿主机常驻进程
- 每个会话使用数据库生成的稳定 `/thread/{meshId}` 地址，支持前进、后退和跨机器恢复
- 隔离聊天 Session、项目/目录分组与折叠、快捷新建、Fork 和侧边聊天
- Codex 工作状态、用户消息发送状态、实时回复、审批与目标管理
- 受限文件浏览、语法高亮、图片预览放大和 Agent 文件链接
- 文件/图片上传、剪贴板图片粘贴、8 MB 受限下载；路径经远端 `realpath` 校验并限定在线程工作目录

## 反向 SSH

在服务端启用 Relay：

```bash
ssh-keygen -t ed25519 -N '' -f ./relay_host_ed25519
RELAY_ENABLED=1
RELAY_PUBLIC_HOST=mesh.example.com
RELAY_HOST_KEY_FILE=./relay_host_ed25519
```

Web 的“机器”窗口中为已登记 SSH 主机启用隧道，会生成一次性显示的隧道私钥、固定的 Relay host key 和启动命令。隧道私钥只安装在宿主机，控制面仅保存公钥；再次启用会轮换密钥并立即使旧隧道失效。生产环境应使用 systemd/launchd 保活，配置 `ServerAliveInterval`、`ServerAliveCountMax` 和 `ExitOnForwardFailure`。

Relay 不为 `-R` 创建网络监听端口。经过租户授权的控制面直接申请 SSH forwarded channel，因此其他租户和公网无法扫描反向端点。隧道身份密钥与控制面登录宿主机的 SSH 密钥必须分离。

## 本地运行

要求 Node.js 20+。如果启用控制面本机 Codex，还需要安装并登录 Codex CLI。

```bash
cp .env.example .env
npm install
npm run dev
```

开发页面位于 `http://127.0.0.1:5173`，Vite 会代理到 8787 端口的 Server。首次注册的账户会自动成为管理员。

生产构建：

```bash
npm run build
npm start
```

未设置 `DATABASE_URL` 时，数据默认保存在 `~/.codex-mesh/database`。生产环境建议使用 PostgreSQL：

```bash
DATABASE_URL=postgresql://user:password@db.example.com:5432/codex_mesh
```

## 添加 SSH 主机

1. 确保 Server 能通过 SSH 访问目标主机，目标用户已安装并登录 Codex CLI。
2. 登录 Web 界面，打开“SSH 主机”，点击“添加 SSH 主机”。
3. 推荐生成主机专用 Ed25519 密钥，并在目标主机执行界面给出的幂等公钥安装脚本。
4. 探测 SSH host key，通过目标主机控制台或可信渠道核对 SHA-256 指纹，再确认保存。
5. 也可以上传已有 OpenSSH 私钥；上传内容只应通过 HTTPS 传输。

生成密钥时，私钥只存在控制面内存和加密数据库中，浏览器只收到公钥。主机指纹一旦保存便严格固定；指纹变化会拒绝连接，需要显式重新登记主机。

## 部署注意

- 公网部署必须使用 HTTPS/WSS，并把 `BETTER_AUTH_URL` 和 `TRUSTED_ORIGINS` 设置为公开地址。
- `BETTER_AUTH_SECRET` 必须是至少 32 字符的随机值，并在实例生命周期内保持不变。
- `SSH_KEY_ENCRYPTION_KEY` 必须是独立生成的高熵密钥。轮换前必须重新加密已有 SSH 凭据；丢失后无法恢复私钥。
- Server 默认监听 `127.0.0.1:8787`；仅在反向代理或私有网络后设置 `HOST=0.0.0.0`。
- 生产环境必须使用 HTTPS；反向代理日志、错误日志和审计元数据不得记录私钥或口令。
- SSH 主机应使用专用低权限 Unix 用户、禁用密码登录，并通过 `AllowUsers`、防火墙或私有网络限制来源。
- Server 只暴露明确白名单中的 Codex RPC；远端文件读取会先经 `realpath` 校验并限制在会话工作目录内。
- 默认 `CODEX_LOCAL_MACHINE=off`；仅本地开发需要时才启用控制面本机 Codex。

仓库提供了生产 Dockerfile、`deploy/compose.yml` 和 nginx WebSocket 反代示例。控制面容器默认使用只读根文件系统、非 root 用户和持久化 `/data` 卷。

完整变量见 [.env.example](./.env.example)。

容器发布分为 `develop` 的 `dev` 通道与 `vMAJOR.MINOR.PATCH` 的稳定通道。Docker、Docker Compose、GHCR、分支策略和发版步骤见 [部署文档](./docs/deployment.md)。

## 验证

```bash
npm run check
npm run e2e:control
```

真实 SSH + Codex 验收是显式 opt-in 的付费测试：

```bash
E2E_REAL_CODEX=1 \
E2E_SSH_MACHINE_ID=<已登记的主机 ID> \
E2E_EMAIL=<测试账号> E2E_PASSWORD=<测试密码> \
npm run e2e:real
```

测试默认使用 `gpt-5.6-luna`、`reasoningEffort=none` 和单条固定短回复，覆盖 SSH 建连、host key pin、app-server 初始化、模型列表、线程创建、真实 turn、事件、持久化读取与归档。设置 `E2E_REMOTE_CWD`（以及可选的 `E2E_REMOTE_FILE`）还会验证远端目录、文件读取和目录穿越防护。可通过 `E2E_MODEL` 覆盖模型。普通 `npm run check` 和 `e2e:control` 不会产生模型费用。

局域网 `devbox` 完整反向隧道验收：

```bash
E2E_REAL_CODEX=1 npm run e2e:devbox
```

该测试自动使用本机 OpenSSH config 中的 `devbox`，启动临时控制面和 Relay，并以一次真实低成本 turn 覆盖 goal、fork、side、diff、文本与图片上传、图片输入/预览、文件下载、host key pin 和反向隧道。临时凭据、远端隧道进程及测试线程都会清理。可用 `E2E_DEVBOX_HOST`、`E2E_SSH_PRIVATE_KEY_PATH`、`E2E_RELAY_PUBLIC_HOST` 覆盖环境。

## License

MIT
