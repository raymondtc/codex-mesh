# Codex Mesh

Codex Mesh 是一个自托管的 Codex 控制面。用户在浏览器登录后，可以管理自己的 Codex 机器、项目和会话；仓库、Codex 登录凭据、沙箱与工具执行仍留在各自机器上。

## 架构

```text
浏览器 ── HTTPS / WSS ──► Codex Mesh Server ──► PostgreSQL / PGlite
                              ▲
                              │ 出站 WSS（一次性配对码 + 机器密钥）
                              │
                        codex-mesh Agent
                              │ Unix socket / stdio
                              ▼
                       codex app-server
```

Agent 主动连接 Server，因此 Codex 机器不需要公网 IP、FRP 或开放入站端口。OpenAI/Codex 凭据不会上传到控制面。

## 已实现

- Better Auth 邮箱密码注册、登录、HttpOnly Session Cookie 和首用户管理员
- 用户列表与管理员角色管理，用户之间的机器和会话数据隔离
- 默认持久化 PGlite，设置 `DATABASE_URL` 后使用 PostgreSQL；启动时自动迁移
- 一次性机器配对码、哈希存储机器密钥、在线状态、撤销和审计事件
- npm Agent 出站连接控制面，并复用本机 Codex daemon 或启动 `codex app-server`
- 每个会话使用数据库生成的稳定 `/thread/{meshId}` 地址，支持前进、后退和跨机器恢复
- 隔离聊天 Session、项目/目录分组与折叠、快捷新建、Fork 和侧边聊天
- Codex 工作状态、用户消息发送状态、实时回复、审批与目标管理
- 受限文件浏览、语法高亮、图片预览放大和 Agent 文件链接

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

## 添加 Codex 机器

1. 登录 Web 界面，打开“机器”，点击“添加机器”。
2. 在目标 Codex 机器运行界面给出的命令：

```bash
npx codex-mesh pair --server https://mesh.example.com --code XXXX-XXXX
```

配对码十分钟有效且只能使用一次。Agent 配置保存在 `~/.codex-mesh/agent.json`，权限为 `0600`。后续可以用 `npx codex-mesh start` 重新启动。

## 部署注意

- 公网部署必须使用 HTTPS/WSS，并把 `BETTER_AUTH_URL` 和 `TRUSTED_ORIGINS` 设置为公开地址。
- `BETTER_AUTH_SECRET` 必须是至少 32 字符的随机值，并在实例生命周期内保持不变。
- Server 默认监听 `127.0.0.1:8787`；仅在反向代理或私有网络后设置 `HOST=0.0.0.0`。
- Server 与 Agent 都只转发明确白名单中的 Codex RPC；文件读取被限制在会话工作目录内。
- 如不希望 Server 使用本机 Codex，设置 `CODEX_LOCAL_MACHINE=off`。

仓库提供了生产 Dockerfile、`deploy/compose.yml`、nginx WebSocket 反代示例和 Agent systemd user service。控制面容器默认使用只读根文件系统、非 root 用户和持久化 `/data` 卷。

完整变量见 [.env.example](./.env.example)。

## 验证

```bash
npm run check
npm run e2e:control
```

`e2e:control` 会用隔离的 PGlite 数据库启动控制面，并验证注册、管理员权限、用户隔离、一次性配对、出站 Agent RPC、机器撤销与会话深链接。已有本机 Codex 服务时，还可以运行 `npm run e2e:local` 做真实线程、文件和 turn 测试。

## npm Agent 开发

Agent 包位于 `agent/`，发布名为 `codex-mesh`：

```bash
npm pack -w codex-mesh
npm publish -w codex-mesh
```

## License

MIT
