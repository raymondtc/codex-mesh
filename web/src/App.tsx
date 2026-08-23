import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  ChevronLeft,
  CircleStop,
  Command,
  FolderGit2,
  FolderOpen,
  FileText,
  GitFork,
  KeyRound,
  Image,
  Menu,
  MessageSquarePlus,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  TerminalSquare,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BridgeClient } from "./bridge";
import type { ConnectionState, JsonObject, Project, ServerRequest, Thread, ThreadItem } from "./types";

interface ModelInfo {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
}

interface FileEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "other";
  size: number | null;
  modifiedAt: number | null;
}

interface FilePreview {
  path: string;
  kind: "text" | "image" | "binary";
  size: number;
  content?: string;
  dataUrl?: string;
  mimeType?: string;
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Thread | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [sideThread, setSideThread] = useState<Thread | null>(null);
  const sideThreadIdRef = useRef<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("high");
  const [draft, setDraft] = useState("");
  const [liveText, setLiveText] = useState("");
  const [sideLiveText, setSideLiveText] = useState("");
  const [sideDraft, setSideDraft] = useState("");
  const [sideBusy, setSideBusy] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [fileThreadId, setFileThreadId] = useState("");
  const [filePath, setFilePath] = useState(".");
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [requests, setRequests] = useState<ServerRequest[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showNewThread, setShowNewThread] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [newProjectId, setNewProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
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

  const loadProjects = useCallback(async () => {
    const result = await bridge.call<{ data: Project[] }>("project/list", { limit: 100 });
    setProjects(result.data);
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

  const refreshSideThread = useCallback(async () => {
    const threadId = sideThreadIdRef.current;
    if (!threadId) return;
    try {
      const result = await bridge.call<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
      setSideThread(result.thread);
    } catch {
      // A side thread can be briefly unavailable while its turn is being committed.
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
          loadProjects(),
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
        const event = params as { threadId?: string; delta?: string };
        if (event.delta && event.threadId === sideThreadIdRef.current) setSideLiveText((current) => current + event.delta);
        else if (event.delta && event.threadId === selectedIdRef.current) setLiveText((current) => current + event.delta);
      }
      if (method === "turn/started") {
        const threadId = (params as { threadId?: string }).threadId;
        if (threadId === sideThreadIdRef.current) setSideLiveText("");
        if (threadId === selectedIdRef.current) setLiveText("");
      }
      if (method === "item/completed") {
        const event = params as { threadId?: string; item?: ThreadItem };
        if (event.item?.type === "agentMessage" && event.threadId === sideThreadIdRef.current) setSideLiveText("");
        if (event.item?.type === "agentMessage" && event.threadId === selectedIdRef.current) setLiveText("");
      }
      if (method === "turn/completed" || method === "item/completed") {
        const threadId = (params as { threadId?: string }).threadId;
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => {
          if (threadId === selectedIdRef.current) void refreshSelected();
          if (threadId === sideThreadIdRef.current) void refreshSideThread();
          void loadThreads();
          if (method === "turn/completed" && threadId === selectedIdRef.current) setLiveText("");
          if (method === "turn/completed" && threadId === sideThreadIdRef.current) setSideLiveText("");
        }, 120);
      }
      if (method.startsWith("thread/") && method !== "thread/tokenUsage/updated") void loadThreads();
      if (method.startsWith("project/")) void loadProjects();
    };

    bridge.onServerRequest = (request) => {
      setRequests((current) => [...current.filter((item) => item.id !== request.id), request]);
    };

    bridge.connect(token);
    return () => {
      window.clearTimeout(refreshTimer.current);
      bridge.disconnect();
    };
  }, [bridge, loadProjects, loadThreads, refreshSelected, refreshSideThread, token]);

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
        ...(newProjectId ? { projectId: newProjectId } : {}),
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

  async function createProject() {
    if (!projectName.trim() || !projectRoot.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.call<{ project: Project }>("project/create", {
        name: projectName.trim(),
        roots: [{ path: projectRoot.trim() }],
        idempotencyKey: crypto.randomUUID(),
      });
      setProjects((current) => [...current, result.project].sort((a, b) => a.position - b.position));
      setNewProjectId(result.project.id);
      setProjectName("");
      setProjectRoot("");
      setShowNewProject(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function assignProject(projectId: string) {
    if (!selected) return;
    setError("");
    try {
      const result = await bridge.call<{ thread: Thread }>("thread/metadata/update", {
        threadId: selected.id,
        projectId: projectId || "",
      });
      setSelected((current) => current ? { ...current, projectId: result.thread.projectId } : current);
      await loadThreads();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function forkThread(openBeside = false) {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.call<{ thread: Thread }>("thread/fork", { threadId: selected.id });
      if (openBeside) {
        sideThreadIdRef.current = result.thread.id;
        const sideName = `${selected.name || selected.preview || "任务"} · 侧聊`;
        setSideThread({ ...result.thread, name: sideName });
        setSideLiveText("");
        await bridge.call("thread/name/set", { threadId: result.thread.id, name: sideName });
      } else {
        selectedIdRef.current = result.thread.id;
        setSelected(result.thread);
        setLiveText("");
      }
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
    if (message === "/fork") {
      setDraft("");
      await forkThread();
      return;
    }
    if (message === "/side") {
      setDraft("");
      await forkThread(true);
      return;
    }
    if (message === "/new") {
      setDraft("");
      setNewCwd(selected.cwd);
      setShowNewThread(true);
      return;
    }
    if (message === "/project") {
      setDraft("");
      setProjectRoot(selected.cwd);
      setShowNewProject(true);
      return;
    }
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

  async function sendSideTurn() {
    if (!sideThread || !sideDraft.trim() || sideBusy) return;
    const message = sideDraft.trim();
    setSideDraft("");
    setSideBusy(true);
    setSideLiveText("");
    setError("");
    try {
      await bridge.call("turn/start", {
        threadId: sideThread.id,
        input: [{ type: "text", text: message, text_elements: [] }],
        ...(model ? { model } : {}),
        effort,
      });
      await refreshSideThread();
    } catch (reason) {
      setSideDraft(message);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSideBusy(false);
    }
  }

  function closeSideThread() {
    sideThreadIdRef.current = null;
    setSideThread(null);
    setSideDraft("");
    setSideLiveText("");
  }

  async function browseFiles(threadId: string, path = ".") {
    setFileBusy(true);
    setError("");
    try {
      const result = await bridge.call<{ path: string; entries: FileEntry[] }>("bridge/fs/readDirectory", { threadId, path });
      setFileThreadId(threadId);
      setFilePath(result.path);
      setFileEntries(result.entries);
      setFilePreview(null);
      setShowFiles(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFileBusy(false);
    }
  }

  async function previewFile(threadId: string, path: string) {
    setFileBusy(true);
    setError("");
    try {
      const result = await bridge.call<FilePreview>("bridge/fs/readFile", { threadId, path });
      setFileThreadId(threadId);
      setFilePreview(result);
      setShowFiles(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFileBusy(false);
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
  const threadGroups = groupThreads(threads, projects);

  return (
    <div className={`app-shell ${sideThread ? "with-side-chat" : ""}`}>
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <header className="sidebar-header">
          <div className="brand"><span className="brand-mark small"><Command size={18} /></span><span>Codex Remote</span></div>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭侧边栏"><X size={19} /></button>
        </header>
        <div className="sidebar-create"><button className="new-thread" onClick={() => setShowNewThread(true)}><MessageSquarePlus size={17} /> 新建任务</button><button className="project-button" onClick={() => { setProjectRoot(selected?.cwd ?? newCwd); setShowNewProject(true); }}><Plus size={15} /> 项目</button></div>
        <div className="thread-list">
          <div className="section-label"><span>项目与任务</span><button className="icon-button" onClick={() => { void loadProjects(); void loadThreads(); }} aria-label="刷新"><RefreshCw size={14} /></button></div>
          {threadGroups.map((group) => <section className="project-group" key={group.id}><div className="project-heading"><FolderGit2 size={13} /><strong>{group.name}</strong><span>{group.threads.length}</span></div>{group.threads.map((thread) => (
              <button key={thread.id} className={`thread-row ${selected?.id === thread.id ? "active" : ""}`} onClick={() => void selectThread(thread)}>
                <span className={`status-dot ${isThreadActive(thread) ? "running" : ""}`} />
                <span className="thread-copy">
                  <strong>{thread.name || thread.preview || "新任务"}</strong>
                  <small>{thread.forkedFromId && <GitFork size={11} />} {shortPath(thread.cwd)}</small>
                </span>
                <time>{relativeTime(thread.updatedAt)}</time>
              </button>
            ))}</section>)}
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
          {selected && <select className="project-select" value={selected.projectId ?? ""} onChange={(event) => void assignProject(event.target.value)} aria-label="所属项目"><option value="">按目录归类</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>}
          {selected && <button className="icon-button" onClick={() => void browseFiles(selected.id)} aria-label="浏览项目文件" title="文件"><FolderOpen size={17} /></button>}
          {selected && <button className="icon-button" onClick={() => void forkThread()} disabled={busy || running} aria-label="Fork 当前任务" title="Fork 当前任务"><GitFork size={17} /></button>}
          {selected && <button className="icon-button" onClick={() => void forkThread(true)} disabled={busy || running || Boolean(sideThread)} aria-label="在侧边聊天中 Fork" title="侧边聊天"><PanelRightOpen size={17} /></button>}
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
              {(selected.turns ?? []).flatMap((turn) => turn.items ?? []).map((item, index) => <TimelineItem item={item} threadId={selected.id} openFile={previewFile} key={item.id ?? `${item.type}-${index}`} />)}
              {liveText && <article className="timeline-item assistant live"><div className="avatar"><Bot size={17} /></div><div className="bubble markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{liveText}</ReactMarkdown><span className="cursor" /></div></article>}
              {!selected.turns?.some((turn) => turn.items?.length) && !liveText && <div className="thread-empty"><Bot size={28} /><p>发送第一条指令开始这个任务。</p></div>}
            </section>

            <section className="composer-wrap">
              {requests.filter((request) => requestThreadId(request) !== sideThread?.id).map((request) => <ApprovalCard key={String(request.id)} request={request} resolve={(result) => resolveRequest(request, result)} />)}
              <div className="composer">
                {draft.startsWith("/") && <CommandMenu choose={(command) => setDraft(command)} />}
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

      {sideThread && <aside className="side-chat">
        <header className="side-chat-header"><div><span>侧边聊天</span><strong>{sideThread.name || sideThread.preview || "Fork"}</strong></div><button className="icon-button" onClick={closeSideThread} aria-label="关闭侧边聊天"><X size={18} /></button></header>
        <section className="side-timeline">
          {(sideThread.turns ?? []).flatMap((turn) => turn.items ?? []).map((item, index) => <TimelineItem item={item} threadId={sideThread.id} openFile={previewFile} key={item.id ?? `side-${item.type}-${index}`} />)}
          {sideLiveText && <article className="timeline-item assistant live"><div className="avatar"><Bot size={17} /></div><div className="bubble markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{sideLiveText}</ReactMarkdown><span className="cursor" /></div></article>}
        </section>
        <section className="side-composer-wrap">
          {requests.filter((request) => requestThreadId(request) === sideThread.id).map((request) => <ApprovalCard key={String(request.id)} request={request} resolve={(result) => resolveRequest(request, result)} />)}
          <div className="composer"><textarea value={sideDraft} onChange={(event) => setSideDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendSideTurn(); } }} placeholder="在 Fork 中继续探索…" rows={2} /><div className="composer-actions"><small>独立 Fork，不影响主对话</small><button className="send-button" disabled={!sideDraft.trim() || sideBusy} onClick={() => void sendSideTurn()} aria-label="发送侧边消息"><Send size={17} /></button></div></div>
        </section>
      </aside>}

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
            <label htmlFor="new-project">项目</label>
            <select id="new-project" value={newProjectId} onChange={(event) => setNewProjectId(event.target.value)}><option value="">不指定（按目录归类）</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
            <div className="safety-note"><ShieldAlert size={18} /><span>默认使用 workspace-write 沙箱和 on-request 审批。</span></div>
            <button className="primary" disabled={!newCwd.trim() || busy} onClick={() => void createThread()}>{busy ? "创建中…" : "创建任务"}</button>
          </section>
        </div>
      )}

      {showNewProject && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-label="新建项目">
          <section className="modal">
            <header><button className="icon-button" onClick={() => setShowNewProject(false)}><ChevronLeft size={20} /></button><h2>新建项目</h2></header>
            <label htmlFor="project-name">项目名称</label>
            <input id="project-name" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="例如 Codex Mesh" autoFocus />
            <label htmlFor="project-root">项目根目录</label>
            <input id="project-root" value={projectRoot} onChange={(event) => setProjectRoot(event.target.value)} placeholder="/absolute/path/to/repository" />
            <button className="primary" disabled={!projectName.trim() || !projectRoot.trim() || busy} onClick={() => void createProject()}>{busy ? "创建中…" : "创建项目"}</button>
          </section>
        </div>
      )}

      {showFiles && <div className="file-layer" role="dialog" aria-modal="true" aria-label="文件浏览器"><section className="file-browser">
        <header><div><span>THREAD FILES</span><strong>{filePath}</strong></div><button className="icon-button" onClick={() => setShowFiles(false)} aria-label="关闭文件浏览"><X size={18} /></button></header>
        <div className="file-browser-body">
          <aside className="file-tree">
            {filePath !== "." && <button className="file-row" onClick={() => void browseFiles(fileThreadId, parentPath(filePath))}><ArrowLeft size={15} /><span>上一级</span></button>}
            {fileEntries.map((entry) => <button className="file-row" disabled={entry.type === "other"} key={entry.path} onClick={() => entry.type === "directory" ? void browseFiles(fileThreadId, entry.path) : void previewFile(fileThreadId, entry.path)}>{entry.type === "directory" ? <FolderOpen size={15} /> : isImagePath(entry.path) ? <Image size={15} /> : <FileText size={15} />}<span>{entry.name}</span>{entry.size !== null && entry.type === "file" && <small>{formatBytes(entry.size)}</small>}</button>)}
          </aside>
          <main className="file-preview">{fileBusy ? <div className="preview-empty"><RefreshCw className="spin" size={24} /> 读取中…</div> : filePreview ? <FilePreviewView preview={filePreview} /> : <div className="preview-empty"><FileText size={30} />选择文件查看内容</div>}</main>
        </div>
      </section></div>}
    </div>
  );
}

function TimelineItem({ item, threadId, openFile }: { item: ThreadItem; threadId: string; openFile: (threadId: string, path: string) => Promise<void> }) {
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
    return <details className="tool-card file-change-card"><summary><Check size={15} /> 文件变更 <span className="tool-status">{statusText(item.status)}</span></summary><div className="change-list">{(item.changes ?? []).map((change) => { const kind = fileChangeKind(change.kind); return <section key={`${change.path}-${kind}`}><header><span className={`change-kind ${kind}`}>{kind}</span><code>{change.path}</code><button onClick={(event) => { event.preventDefault(); void openFile(threadId, change.path); }}>预览</button></header><DiffView diff={change.diff} /></section>; })}</div></details>;
  }
  if (item.type === "imageView" && typeof item.path === "string") {
    return <button className="image-item" onClick={() => void openFile(threadId, item.path as string)}><Image size={17} /><span>{item.path}</span><small>查看图片</small></button>;
  }
  if (item.type === "imageGeneration" && typeof item.result === "string") {
    const source = item.result.startsWith("data:") ? item.result : `data:image/png;base64,${item.result}`;
    return <article className="generated-image"><img src={source} alt={typeof item.revisedPrompt === "string" ? item.revisedPrompt : "Codex 生成的图片"} /></article>;
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

function CommandMenu({ choose }: { choose: (command: string) => void }) {
  const commands = [
    { command: "/fork", label: "Fork 并切换", detail: "复制当前历史为一个新任务" },
    { command: "/side", label: "侧边聊天", detail: "Fork 到右侧并行探索" },
    { command: "/new", label: "新建任务", detail: "从当前目录创建空任务" },
    { command: "/project", label: "新建项目", detail: "以当前目录创建 Codex Project" },
  ];
  return <div className="command-menu">{commands.map((item) => <button type="button" key={item.command} onClick={() => choose(item.command)}><code>{item.command}</code><span><strong>{item.label}</strong><small>{item.detail}</small></span></button>)}</div>;
}

function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="empty-diff">没有可显示的 diff</div>;
  return <pre className="diff-view">{diff.split("\n").map((line, index) => <span className={line.startsWith("+") && !line.startsWith("+++") ? "diff-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-delete" : line.startsWith("@@") ? "diff-hunk" : ""} key={`${index}-${line.slice(0, 20)}`}>{line || " "}</span>)}</pre>;
}

function FilePreviewView({ preview }: { preview: FilePreview }) {
  return <article className="preview-content"><header><strong>{preview.path}</strong><small>{formatBytes(preview.size)}{preview.mimeType ? ` · ${preview.mimeType}` : ""}</small></header>{preview.kind === "image" && preview.dataUrl ? <div className="image-preview"><img src={preview.dataUrl} alt={preview.path} /></div> : preview.kind === "text" ? <pre>{preview.content}</pre> : <div className="preview-empty">二进制文件不支持文本预览</div>}</article>;
}

function requestThreadId(request: ServerRequest): string | undefined {
  return typeof request.params.threadId === "string" ? request.params.threadId : undefined;
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

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") || ".";
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function fileChangeKind(kind: string | { type?: string }): string {
  return typeof kind === "string" ? kind : kind.type ?? "update";
}

function groupThreads(threads: Thread[], projects: Project[]): Array<{ id: string; name: string; threads: Thread[] }> {
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const groups = new Map<string, { id: string; name: string; threads: Thread[]; position: number }>();
  for (const thread of threads) {
    const project = thread.projectId ? projectMap.get(thread.projectId) : undefined;
    const id = project ? `project:${project.id}` : `cwd:${thread.cwd}`;
    const name = project?.name ?? shortPath(thread.cwd);
    const group = groups.get(id) ?? { id, name, threads: [], position: project?.position ?? Number.MAX_SAFE_INTEGER };
    group.threads.push(thread);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => a.position - b.position || (b.threads[0]?.updatedAt ?? 0) - (a.threads[0]?.updatedAt ?? 0));
}
