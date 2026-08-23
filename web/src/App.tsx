import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Bot,
  Check,
  ChevronLeft,
  CircleStop,
  Command,
  FolderGit2,
  KeyRound,
  Menu,
  MessageSquarePlus,
  RefreshCw,
  Send,
  ShieldAlert,
  TerminalSquare,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BridgeClient } from "./bridge";
import type { ConnectionState, JsonObject, ServerRequest, Thread, ThreadItem } from "./types";

interface ModelInfo {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
}

const STORED_TOKEN = "codex-remote-token";

export default function App() {
  const bridge = useMemo(() => new BridgeClient(), []);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [hasConnected, setHasConnected] = useState(false);
  const [token, setToken] = useState(() => localStorage.getItem(STORED_TOKEN) ?? "");
  const [tokenDraft, setTokenDraft] = useState(token);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<Thread | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("high");
  const [draft, setDraft] = useState("");
  const [liveText, setLiveText] = useState("");
  const [requests, setRequests] = useState<ServerRequest[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showNewThread, setShowNewThread] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refreshTimer = useRef<number | undefined>(undefined);

  const loadThreads = useCallback(async () => {
    const result = await bridge.call<{ data: Thread[] }>("thread/list", {
      limit: 60,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    setThreads(result.data);
  }, [bridge]);

  const refreshSelected = useCallback(async () => {
    const threadId = selectedIdRef.current;
    if (!threadId) return;
    try {
      const result = await bridge.call<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
      setSelected(result.thread);
      setThreads((current) => current.map((thread) => (thread.id === result.thread.id ? result.thread : thread)));
    } catch {
      // The thread can be briefly unavailable while app-server is committing a turn.
    }
  }, [bridge]);

  useEffect(() => {
    bridge.onState = (state, message) => {
      setConnection(state);
      setConnectionMessage(message ?? "");
      if (state === "closed" && message === "Token 错误") {
        localStorage.removeItem(STORED_TOKEN);
        setTokenDraft("");
        setHasConnected(false);
      }
      if (state === "ready") {
        setHasConnected(true);
        Promise.all([
          loadThreads(),
          bridge.call<{ data: ModelInfo[] }>("model/list", { includeHidden: false }).then((result) => {
            setModels(result.data);
            const initial = result.data.find((item) => item.isDefault) ?? result.data[0];
            if (initial) {
              setModel(initial.model);
              setEffort(initial.defaultReasoningEffort);
            }
          }),
        ]).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      }
    };

    bridge.onEvent = (method, params) => {
      if (method === "bridge/serverRequestResolved") {
        const resolvedId = String((params as { id?: string | number }).id);
        setRequests((current) => current.filter((item) => String(item.id) !== resolvedId));
        return;
      }
      if (method === "item/agentMessage/delta") {
        const delta = (params as { delta?: string }).delta;
        if (delta) setLiveText((current) => current + delta);
      }
      if (method === "turn/started") setLiveText("");
      if (method === "item/completed") {
        const item = (params as { item?: ThreadItem }).item;
        if (item?.type === "agentMessage") setLiveText("");
      }
      if (method === "turn/completed" || method === "item/completed") {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => {
          void refreshSelected();
          void loadThreads();
          if (method === "turn/completed") setLiveText("");
        }, 120);
      }
      if (method.startsWith("thread/") && method !== "thread/tokenUsage/updated") void loadThreads();
    };

    bridge.onServerRequest = (request) => {
      setRequests((current) => [...current.filter((item) => item.id !== request.id), request]);
    };

    bridge.connect(token);
    return () => {
      window.clearTimeout(refreshTimer.current);
      bridge.disconnect();
    };
  }, [bridge, loadThreads, refreshSelected, token]);

  async function selectThread(thread: Thread) {
    setSidebarOpen(false);
    setError("");
    selectedIdRef.current = thread.id;
    setSelected({ ...thread, turns: thread.turns ?? [] });
    try {
      const result = await bridge.call<{ thread: Thread }>("thread/resume", { threadId: thread.id });
      setSelected(result.thread);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshSelected();
    }
  }

  async function createThread() {
    if (!newCwd.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.call<{ thread: Thread }>("thread/start", {
        cwd: newCwd.trim(),
        ...(model ? { model } : {}),
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      selectedIdRef.current = result.thread.id;
      setSelected(result.thread);
      setShowNewThread(false);
      await loadThreads();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function sendTurn() {
    if (!selected || !draft.trim() || busy) return;
    const message = draft.trim();
    setDraft("");
    setBusy(true);
    setLiveText("");
    setError("");
    try {
      await bridge.call("turn/start", {
        threadId: selected.id,
        input: [{ type: "text", text: message, text_elements: [] }],
        ...(model ? { model } : {}),
        effort,
      });
      await refreshSelected();
    } catch (reason) {
      setDraft(message);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function interruptTurn() {
    if (!selected) return;
    const activeTurn = [...(selected.turns ?? [])].reverse().find((turn) => turn.status === "inProgress");
    if (!activeTurn) return;
    await bridge.call("turn/interrupt", { threadId: selected.id, turnId: activeTurn.id });
  }

  function saveToken(event: React.FormEvent) {
    event.preventDefault();
    localStorage.setItem(STORED_TOKEN, tokenDraft);
    setToken(tokenDraft);
  }

  function changeToken() {
    localStorage.removeItem(STORED_TOKEN);
    setTokenDraft("");
    setHasConnected(false);
    setConnection("closed");
    setConnectionMessage("请输入新 Token");
    bridge.disconnect();
  }

  function resolveRequest(request: ServerRequest, result: unknown) {
    bridge.respond(request.id, result);
    setRequests((current) => current.filter((item) => item.id !== request.id));
  }

  if (connection !== "ready" && !hasConnected) {
    return (
      <main className="connect-page">
        <section className="connect-card">
          <div className="brand-mark"><Command size={28} /></div>
          <p className="eyebrow">CODEX REMOTE</p>
          <h1>连接你的开发主机</h1>
          <p className="muted">浏览器只是遥控器；Codex、代码仓库和命令仍运行在你的主机上。</p>
          <form onSubmit={saveToken}>
            <label htmlFor="token"><KeyRound size={15} /> 访问 Token</label>
            <input id="token" type="password" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder="REMOTE_WEB_TOKEN" autoComplete="current-password" />
            <button className="primary" type="submit"><RefreshCw size={16} /> {connection === "connecting" ? "连接中…" : "重新连接"}</button>
          </form>
          {connectionMessage && <p className="error-text">{connectionMessage}</p>}
          <p className="fine-print">本地默认可以留空；远程访问请使用 HTTPS 和长随机 Token。</p>
        </section>
      </main>
    );
  }

  const running = selected ? isThreadActive(selected) : false;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <header className="sidebar-header">
          <div className="brand"><span className="brand-mark small"><Command size={18} /></span><span>Codex Remote</span></div>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭侧边栏"><X size={19} /></button>
        </header>
        <button className="new-thread" onClick={() => setShowNewThread(true)}><MessageSquarePlus size={17} /> 新建任务</button>
        <div className="thread-list">
          <div className="section-label"><span>最近任务</span><button className="icon-button" onClick={() => void loadThreads()} aria-label="刷新"><RefreshCw size={14} /></button></div>
          {threads.map((thread) => (
            <button key={thread.id} className={`thread-row ${selected?.id === thread.id ? "active" : ""}`} onClick={() => void selectThread(thread)}>
              <span className={`status-dot ${isThreadActive(thread) ? "running" : ""}`} />
              <span className="thread-copy">
                <strong>{thread.name || thread.preview || "新任务"}</strong>
                <small><FolderGit2 size={12} /> {shortPath(thread.cwd)}</small>
              </span>
              <time>{relativeTime(thread.updatedAt)}</time>
            </button>
          ))}
          {!threads.length && <p className="empty-list">还没有 Codex 任务。</p>}
        </div>
        <footer className="sidebar-footer"><span><i className="online-dot" /> app-server 已连接</span><button onClick={changeToken}><KeyRound size={13} /> 更换 Token</button></footer>
      </aside>

      {sidebarOpen && <button className="scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭侧边栏" />}

      <main className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开侧边栏"><Menu size={21} /></button>
          <div className="topbar-title">
            <strong>{selected?.name || selected?.preview || "选择一个任务"}</strong>
            {selected && <small>{selected.cwd}</small>}
          </div>
          {selected && <span className={`run-state ${running ? "running" : ""}`}>{running ? "执行中" : "就绪"}</span>}
        </header>

        {connection !== "ready" && <div className="reconnect-banner"><RefreshCw size={15} /> {connectionMessage || "正在重新连接…"}</div>}
        {error && <div className="error-banner"><ShieldAlert size={16} /> <span>{error}</span><button onClick={() => setError("")}><X size={15} /></button></div>}

        {!selected ? (
          <section className="empty-state">
            <div className="empty-icon"><Bot size={38} /></div>
            <h2>在任何屏幕上继续 Codex 任务</h2>
            <p>查看实时输出、发送后续指令，并在命令越过权限边界时进行审批。</p>
            <button className="primary" onClick={() => setShowNewThread(true)}><MessageSquarePlus size={17} /> 新建任务</button>
          </section>
        ) : (
          <>
            <section className="timeline">
              {(selected.turns ?? []).flatMap((turn) => turn.items ?? []).map((item, index) => <TimelineItem item={item} key={item.id ?? `${item.type}-${index}`} />)}
              {liveText && <article className="timeline-item assistant live"><div className="avatar"><Bot size={17} /></div><div className="bubble markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{liveText}</ReactMarkdown><span className="cursor" /></div></article>}
              {!selected.turns?.some((turn) => turn.items?.length) && !liveText && <div className="thread-empty"><Bot size={28} /><p>发送第一条指令开始这个任务。</p></div>}
            </section>

            <section className="composer-wrap">
              {requests.map((request) => <ApprovalCard key={String(request.id)} request={request} resolve={(result) => resolveRequest(request, result)} />)}
              <div className="composer">
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendTurn(); }
                }} placeholder="给 Codex 发送后续指令…" rows={2} />
                <div className="composer-actions">
                  <div className="runtime-controls">
                    <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="模型">
                      {models.map((item) => <option value={item.model} key={item.id}>{item.displayName}</option>)}
                    </select>
                    <select value={effort} onChange={(event) => setEffort(event.target.value)} aria-label="推理强度">
                      {['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((value) => <option value={value} key={value}>{value}</option>)}
                    </select>
                  </div>
                  {running ? <button className="stop-button" onClick={() => void interruptTurn()}><CircleStop size={17} /> 停止</button> : <button className="send-button" disabled={!draft.trim() || busy} onClick={() => void sendTurn()} aria-label="发送"><Send size={18} /></button>}
                </div>
              </div>
            </section>
          </>
        )}
      </main>

      {showNewThread && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-label="新建任务">
          <section className="modal">
            <header><button className="icon-button" onClick={() => setShowNewThread(false)}><ChevronLeft size={20} /></button><h2>新建 Codex 任务</h2></header>
            <label htmlFor="cwd">工作目录</label>
            <input id="cwd" value={newCwd} onChange={(event) => setNewCwd(event.target.value)} placeholder="/absolute/path/to/repository" autoFocus />
            <label htmlFor="new-model">模型</label>
            <select id="new-model" value={model} onChange={(event) => setModel(event.target.value)}>
              {models.map((item) => <option value={item.model} key={item.id}>{item.displayName}</option>)}
            </select>
            <div className="safety-note"><ShieldAlert size={18} /><span>默认使用 workspace-write 沙箱和 on-request 审批。</span></div>
            <button className="primary" disabled={!newCwd.trim() || busy} onClick={() => void createThread()}>{busy ? "创建中…" : "创建任务"}</button>
          </section>
        </div>
      )}
    </div>
  );
}

function TimelineItem({ item }: { item: ThreadItem }) {
  if (item.type === "userMessage") {
    const text = item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
    return <article className="timeline-item user"><div className="bubble">{text}</div></article>;
  }
  if (item.type === "agentMessage") {
    return <article className="timeline-item assistant"><div className="avatar"><Bot size={17} /></div><div className="bubble markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text ?? ""}</ReactMarkdown></div></article>;
  }
  if (item.type === "reasoning") {
    return <details className="tool-card reasoning"><summary><RefreshCw size={14} /> 思考过程</summary><div>{item.summary?.join("\n\n")}</div></details>;
  }
  if (item.type === "commandExecution") {
    return <details className="tool-card" open={item.status === "inProgress"}><summary><TerminalSquare size={15} /><code>{item.command}</code><span className="tool-status">{statusText(item.status)}</span></summary>{item.aggregatedOutput && <pre>{item.aggregatedOutput}</pre>}</details>;
  }
  if (item.type === "fileChange") {
    return <details className="tool-card"><summary><Check size={15} /> 文件变更 <span className="tool-status">{statusText(item.status)}</span></summary><pre>{JSON.stringify(item.changes, null, 2)}</pre></details>;
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "collabAgentToolCall") {
    return <details className="tool-card"><summary><Command size={15} /> {String(item.server ?? item.tool ?? item.type)} <span className="tool-status">{statusText(item.status)}</span></summary><pre>{JSON.stringify(item.arguments ?? item.result ?? item, null, 2)}</pre></details>;
  }
  if (item.type === "plan") {
    return <article className="plan-card"><strong>计划</strong><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text ?? ""}</ReactMarkdown></div></article>;
  }
  return null;
}

function ApprovalCard({ request, resolve }: { request: ServerRequest; resolve: (result: unknown) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const params = request.params;
  const command = typeof params.command === "string" ? params.command : undefined;
  const reason = typeof params.reason === "string" ? params.reason : undefined;
  const questions = Array.isArray(params.questions) ? params.questions as Array<JsonObject> : [];

  if (request.method === "item/tool/requestUserInput") {
    return <div className="approval-card"><div className="approval-title"><ShieldAlert size={18} /><strong>Codex 需要你的回答</strong></div>{questions.map((question) => {
      const id = String(question.id);
      const options = Array.isArray(question.options) ? question.options as Array<JsonObject> : [];
      return <div className="question" key={id}><label>{String(question.question ?? "")}</label>{options.length ? <div className="option-grid">{options.map((option) => <button key={String(option.label)} onClick={() => setAnswers((current) => ({ ...current, [id]: String(option.label) }))} className={answers[id] === option.label ? "selected" : ""}>{String(option.label)}</button>)}</div> : <input type={question.isSecret ? "password" : "text"} value={answers[id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))} />}</div>;
    })}<button className="primary compact" onClick={() => resolve({ answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, { answers: [answer] }])) })}>提交回答</button></div>;
  }

  const isFile = request.method.includes("fileChange") || request.method === "applyPatchApproval";
  return <div className="approval-card"><div className="approval-title"><ShieldAlert size={18} /><strong>{isFile ? "批准文件变更" : "批准命令执行"}</strong></div>{reason && <p>{reason}</p>}{command && <pre>{command}</pre>}<div className="approval-actions"><button onClick={() => resolve({ decision: "decline" })}>拒绝</button><button onClick={() => resolve({ decision: "acceptForSession" })}>本会话允许</button><button className="primary compact" onClick={() => resolve({ decision: "accept" })}>允许一次</button></div></div>;
}

function isThreadActive(thread: Thread): boolean {
  return typeof thread.status === "object" && thread.status !== null && (thread.status as { type?: string }).type === "active";
}

function statusText(status: unknown): string {
  if (typeof status === "string") return status;
  if (status && typeof status === "object" && "type" in status) return String((status as { type: unknown }).type);
  return "";
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
