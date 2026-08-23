# codex-mesh

Outbound machine Agent for [Codex Mesh](https://github.com/raymondtc/codex-mesh). It keeps repositories and Codex/OpenAI credentials on your machine while connecting to a self-hosted control plane over WSS.

```bash
npx codex-mesh pair --server https://mesh.example.com --code XXXX-XXXX
```

The pairing code is created in the Codex Mesh Web UI. Pairing saves an owner-only configuration at `~/.codex-mesh/agent.json` and starts the Agent in the foreground. Restart it later with:

```bash
npx codex-mesh start
```

Other commands:

```bash
npx codex-mesh status
npx codex-mesh --version
```

Options and environment variables:

- `pair --name NAME` changes the machine name.
- `pair --no-start` saves the pairing without starting the Agent.
- `CODEX_MESH_AGENT_CONFIG` changes the config path.
- `CODEX_BIN` changes the Codex executable.
- `CODEX_CWD` sets the fallback app-server working directory.
- `CODEX_APP_SERVER_URL` selects `unix://`, `ws://`, `wss://`, or `stdio://` explicitly.
- `CODEX_HOME` changes where the local daemon socket is discovered.

Requires Node.js 20+ and an installed, logged-in Codex CLI. Use HTTPS/WSS when the control plane is not strictly local.

MIT License
