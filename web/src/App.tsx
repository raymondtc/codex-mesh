import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  CheckCircle2,
  Copy,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Command,
  FolderGit2,
  FolderOpen,
  FileText,
  GitFork,
  GitBranch,
  Image,
  LoaderCircle,
  LogOut,
  Menu,
  MessageCircle,
  MonitorCog,
  Pencil,
  MessageSquarePlus,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Target,
  Trash2,
  Users,
  Send,
  ShieldAlert,
  TerminalSquare,
  X,
  ZoomIn,
} from "lucide-react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { authClient } from "./auth-client";
import { BridgeClient } from "./bridge";
import type { ConnectionState, JsonObject, Machine, Project, ServerRequest, Thread, ThreadGoal, ThreadItem, Turn } from "./types";

interface ModelInfo {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
}

type PermissionMode = "read-only" | "workspace-write" | "full-access";
type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

interface UserSettings {
  defaultPermission: PermissionMode;
  defaultModel: string | null;
  defaultReasoningEffort: ReasoningEffort;
}

const REASONING_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const SLASH_COMMANDS = [
  { command: "/fork", label: "Fork 并切换", detail: "复制当前历史为一个新任务" },
  { command: "/side", label: "侧边聊天", detail: "Fork 到右侧并行探索" },
  { command: "/new", label: "新建任务", detail: "从当前目录创建空任务" },
  { command: "/project", label: "新建项目", detail: "以当前目录创建 Codex Project" },
] as const;

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

const COLLAPSED_GROUPS_KEY = "codex-remote-collapsed-groups";
const CHAT_WORKSPACE_SEGMENTS = new Set(["codex-mesh-chat-workspaces", "codex-remote-chat-workspaces"]);

interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
  createdAt: string;
}

interface ThreadGroup {
  id: string;
  name: string;
  threads: Thread[];
  position: number;
  kind: "chat" | "project" | "directory";
  root?: string;
  projectId?: string;
}

interface OptimisticMessage {
  id: string;
  threadId: string;
  text: string;
  state: "sending" | "sent" | "failed";
  turnId?: string;
  error?: string;
}

interface ZoomedImage {
  src: string;
  alt: string;
}

export default function App() {
  const authSession = authClient.useSession();
  const bridge = useMemo(() => new BridgeClient(), []);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [hasConnected, setHasConnected] = useState(false);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState("");
  const [showMachines, setShowMachines] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [currentRole, setCurrentRole] = useState("");
  const [enrollment, setEnrollment] = useState<{ code: string; expiresAt: string } | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Thread | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [sideThread, setSideThread] = useState<Thread | null>(null);
  const [sideHiddenTurnIds, setSideHiddenTurnIds] = useState<Set<string>>(new Set());
  const sideThreadIdRef = useRef<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort>("high");
  const [permission, setPermission] = useState<PermissionMode>("workspace-write");
  const [draft, setDraft] = useState("");
  const [slashCommandIndex, setSlashCommandIndex] = useState(0);
  const [liveText, setLiveText] = useState("");
  const [sideLiveText, setSideLiveText] = useState("");
  const [sideDraft, setSideDraft] = useState("");
  const [sideBusy, setSideBusy] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([]);
  const [activeTurns, setActiveTurns] = useState<Record<string, string>>({});
  const [activityLabels, setActivityLabels] = useState<Record<string, string>>({});
  const [zoomedImage, setZoomedImage] = useState<ZoomedImage | null>(null);
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
  const [goal, setGoal] = useState<ThreadGoal | null>(null);
  const [showGoal, setShowGoal] = useState(false);
  const [goalObjective, setGoalObjective] = useState("");
  const [goalBudget, setGoalBudget] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? "[]") as unknown;
      return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
    } catch {
      return new Set();
    }
  });
  const refreshTimer = useRef<number | undefined>(undefined);
  const threadsRef = useRef<Thread[]>([]);
  const timelineRef = useRef<HTMLElement | null>(null);
  const sideTimelineRef = useRef<HTMLElement | null>(null);

  const loadThreads = useCallback(async () => {
    const result = await bridge.call<{ data: Thread[] }>("thread/list", {
      limit: 60,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    threadsRef.current = result.data;
    setThreads(result.data);
    return result.data;
  }, [bridge]);

  const loadProjects = useCallback(async () => {
    const result = await bridge.call<{ data: Project[] }>("project/list", { limit: 100 });
    setProjects(result.data);
  }, [bridge]);

  const loadMachines = useCallback(async () => {
    const result = await bridge.call<{ data: Machine[] }>("bridge/machine/list");
    setMachines(result.data);
    return result.data;
  }, [bridge]);

  const refreshSelected = useCallback(async () => {
    const threadId = selectedIdRef.current;
    if (!threadId) return;
    try {
      const result = await bridge.call<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
      setSelected(result.thread);
      setThreads((current) => current.map((thread) => (thread.id === result.thread.id ? result.thread : thread)));
      reconcileOptimisticMessage(result.thread, setOptimisticMessages);
      return result.thread;
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
      reconcileOptimisticMessage(result.thread, setOptimisticMessages);
      return result.thread;
    } catch {
      // A side thread can be briefly unavailable while its turn is being committed.
    }
  }, [bridge]);

  const loadGoal = useCallback(async (threadId: string) => {
    const result = await bridge.call<{ goal: ThreadGoal | null }>("thread/goal/get", { threadId });
    setGoal(result.goal);
  }, [bridge]);

  useEffect(() => {
    if (!authSession.data) {
      bridge.disconnect();
      setHasConnected(false);
      return;
    }
    void fetch("/api/me").then(async (response) => {
      if (!response.ok) throw new Error("Unable to load current user");
      return response.json() as Promise<{ user: { role?: string } }>;
    }).then((value) => setCurrentRole(value.user.role ?? "user")).catch(() => setCurrentRole("user"));
    bridge.onReady = (info) => {
      const initialized = info.initialized as { machineId?: string | null } | undefined;
      if (initialized?.machineId) setSelectedMachineId(initialized.machineId);
    };
    bridge.onState = (state, message) => {
      setConnection(state);
      setConnectionMessage(message ?? "");
      if (state === "closed" && message === "登录已失效") {
        setHasConnected(false);
        void authSession.refetch();
      }
      if (state === "ready") {
        setHasConnected(true);
        Promise.all([
          loadMachines(),
          loadThreads(),
          loadProjects(),
          bridge.call<{ data: ModelInfo[] }>("model/list", { includeHidden: false }),
          fetch("/api/settings").then(async (response) => {
            if (!response.ok) throw new Error("无法加载用户默认设置");
            return response.json() as Promise<UserSettings>;
          }),
        ]).then(([, loadedThreads, , modelResult, settings]) => {
          setModels(modelResult.data);
          const preferred = modelResult.data.find((item) => item.model === settings.defaultModel);
          const initial = preferred ?? modelResult.data.find((item) => item.isDefault) ?? modelResult.data[0];
          if (initial) setModel(initial.model);
          setEffort(settings.defaultReasoningEffort);
          setPermission(settings.defaultPermission);
          const conversationId = threadIdFromLocation();
          if (!conversationId) return;
          const routeThread = loadedThreads.find((thread) => thread.meshId === conversationId);
          if (routeThread) void selectThread(routeThread, "none");
          else void bridge.call<{ thread: Thread }>("bridge/conversation/resolve", { conversationId })
            .then((result) => selectThread(result.thread, "none"))
            .catch(() => {
              window.history.replaceState(null, "", "/");
              setError("地址中的会话不存在或已不可用");
            });
        }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
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
        const event = params as { threadId?: string; turn?: Turn };
        const threadId = event.threadId;
        if (threadId) {
          setActiveTurns((current) => ({ ...current, [threadId]: event.turn?.id ?? current[threadId] ?? "" }));
          setActivityLabels((current) => ({ ...current, [threadId]: "Codex 正在思考" }));
        }
        if (threadId === sideThreadIdRef.current) setSideLiveText("");
        if (threadId === selectedIdRef.current) setLiveText("");
      }
      if (method === "item/started") {
        const event = params as { threadId?: string; item?: ThreadItem };
        if (event.threadId) {
          setActivityLabels((current) => ({ ...current, [event.threadId as string]: activityLabel(event.item) }));
          if (event.item?.type === "userMessage") {
            if (event.threadId === selectedIdRef.current) void refreshSelected();
            if (event.threadId === sideThreadIdRef.current) void refreshSideThread();
          }
        }
      }
      if (method === "item/completed") {
        const event = params as { threadId?: string; item?: ThreadItem };
        if (event.item?.type === "agentMessage" && event.threadId === sideThreadIdRef.current) setSideLiveText("");
        if (event.item?.type === "agentMessage" && event.threadId === selectedIdRef.current) setLiveText("");
        if (event.threadId) setActivityLabels((current) => ({ ...current, [event.threadId as string]: "Codex 正在继续处理" }));
      }
      if (method === "turn/completed" || method === "item/completed") {
        const threadId = (params as { threadId?: string }).threadId;
        if (method === "turn/completed" && threadId) {
          setActiveTurns((current) => {
            const next = { ...current };
            delete next[threadId];
            return next;
          });
          setActivityLabels((current) => {
            const next = { ...current };
            delete next[threadId];
            return next;
          });
        }
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => {
          if (threadId === selectedIdRef.current) void refreshSelected();
          if (threadId === sideThreadIdRef.current) void refreshSideThread();
          void loadThreads();
          if (method === "turn/completed" && threadId === selectedIdRef.current) setLiveText("");
          if (method === "turn/completed" && threadId === sideThreadIdRef.current) setSideLiveText("");
        }, 120);
      }
      if (method === "thread/goal/updated" && (params as { threadId?: string }).threadId === selectedIdRef.current) {
        setGoal((params as { goal: ThreadGoal }).goal);
      }
      if (method === "thread/goal/cleared" && (params as { threadId?: string }).threadId === selectedIdRef.current) setGoal(null);
      if (method.startsWith("thread/") && method !== "thread/tokenUsage/updated") void loadThreads();
      if (method.startsWith("project/")) void loadProjects();
    };

    bridge.onServerRequest = (request) => {
      setRequests((current) => [...current.filter((item) => item.id !== request.id), request]);
    };

    const handleHistoryNavigation = () => {
      const conversationId = threadIdFromLocation();
      if (!conversationId) {
        selectedIdRef.current = null;
        setSelected(null);
        setGoal(null);
        return;
      }
      const thread = threadsRef.current.find((item) => item.meshId === conversationId);
      if (thread) void selectThread(thread, "none");
      else void bridge.call<{ thread: Thread }>("bridge/conversation/resolve", { conversationId })
        .then((result) => selectThread(result.thread, "none"))
        .catch(() => setError("无法打开历史地址中的会话"));
    };
    window.addEventListener("popstate", handleHistoryNavigation);

    bridge.connect();
    return () => {
      window.clearTimeout(refreshTimer.current);
      window.removeEventListener("popstate", handleHistoryNavigation);
      bridge.disconnect();
    };
  }, [authSession.data?.user.id, bridge, loadMachines, loadProjects, loadThreads, refreshSelected, refreshSideThread]);

  async function selectThread(thread: Thread, routeMode: "push" | "replace" | "none" = "push") {
    setSidebarOpen(false);
    setError("");
    selectedIdRef.current = thread.id;
    if (thread.machineId) setSelectedMachineId(thread.machineId);
    if (routeMode !== "none") setThreadRoute(thread.meshId ?? thread.id, routeMode);
    setGoal(null);
    setSelected({ ...thread, turns: thread.turns ?? [] });
    try {
      const result = await bridge.call<{ thread: Thread }>("thread/resume", { threadId: thread.id });
      setSelected(result.thread);
      await loadGoal(thread.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshSelected();
    }
  }

  async function saveGoal(status: ThreadGoal["status"] = "active") {
    if (!selected || (!goalObjective.trim() && !goal)) return;
    setBusy(true);
    try {
      const result = await bridge.call<{ goal: ThreadGoal }>("thread/goal/set", {
        threadId: selected.id,
        ...(goalObjective.trim() ? { objective: goalObjective.trim() } : {}),
        status,
        tokenBudget: goalBudget ? Number(goalBudget) : null,
      });
      setGoal(result.goal); setShowGoal(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function clearGoal() {
    if (!selected) return;
    await bridge.call("thread/goal/clear", { threadId: selected.id });
    setGoal(null); setShowGoal(false);
  }

  async function renameThread() {
    if (!selected) return;
    const name = window.prompt("输入新的对话名称", selected.name || selected.preview || "");
    if (!name?.trim()) return;
    if (!isThreadStarted(selected)) {
      setSelected({ ...selected, name: name.trim() });
      return;
    }
    await bridge.call("thread/name/set", { threadId: selected.id, name: name.trim() });
    setSelected({ ...selected, name: name.trim() }); await loadThreads();
  }

  async function archiveThread() {
    if (!selected) return;
    if (!isThreadStarted(selected)) {
      selectedIdRef.current = null; setSelected(null); setGoal(null); setThreadRoute(null, "push");
      return;
    }
    if (!window.confirm("归档当前对话？")) return;
    await bridge.call("thread/archive", { threadId: selected.id });
    selectedIdRef.current = null; setSelected(null); setGoal(null); setThreadRoute(null, "push"); await loadThreads();
  }

  function openNewThread(cwd = "", projectId = "") {
    setNewCwd(cwd);
    setNewProjectId(projectId);
    setShowNewThread(true);
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  async function createChatSession() {
    if (busy) return;
    if (!bridge.supports("bridge/session/start")) {
      setError("当前服务端版本过旧，不支持新建聊天。请重启服务以加载最新构建。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await bridge.call<{ thread: Thread }>("bridge/session/start", {
        ...(model ? { model } : {}),
        ...threadPermissionParams(permission),
      });
      selectedIdRef.current = result.thread.id;
      setThreadRoute(result.thread.meshId ?? result.thread.id, "push");
      setSelected({ ...result.thread, name: result.thread.name ?? "新聊天" });
      setGoal(null);
      setLiveText("");
      setSidebarOpen(false);
      await loadThreads();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
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
        ...threadPermissionParams(permission),
      });
      selectedIdRef.current = result.thread.id;
      setThreadRoute(result.thread.meshId ?? result.thread.id, "push");
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
        idempotencyKey: clientId(),
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

  async function forkThread(source: Thread | null = selected, openBeside = false, useWorktree = false) {
    if (!source || busy) return;
    let worktree: { mainRoot: string; worktreePath: string; branch: string } | null = null;
    if (useWorktree) {
      const suggested = `codex/${new Date().toISOString().slice(0, 10)}-${source.id.slice(-6)}`;
      const branch = window.prompt("输入新 worktree 的分支名", suggested)?.trim();
      if (!branch) return;
      if (!window.confirm(`将创建并保留：\n分支 ${branch}\n对应 Git worktree。删除会话不会删除它。`)) return;
      try {
        worktree = await bridge.call("bridge/git/worktree/create", { threadId: source.id, branch });
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return;
      }
    }
    setBusy(true);
    setError("");
    try {
      const result = await bridge.call<{ thread: Thread }>("thread/fork", { threadId: source.id, ...(worktree ? { cwd: worktree.worktreePath } : {}), ...(openBeside ? { excludeTurns: true } : {}) });
      const kind = worktree ? "worktree" : openBeside ? "side" : "fork";
      await bridge.call("bridge/conversation/metadata/update", {
        threadId: result.thread.id,
        kind,
        parentRemoteThreadId: source.id,
        ...(worktree ? { mainRoot: worktree.mainRoot, worktreePath: worktree.worktreePath, branch: worktree.branch } : {}),
      });
      result.thread.conversationKind = kind;
      result.thread.parentRemoteThreadId = source.id;
      if (worktree) Object.assign(result.thread, worktree);
      if (openBeside) {
        sideThreadIdRef.current = result.thread.id;
        setSideHiddenTurnIds(new Set((source.turns ?? []).map((turn) => turn.id)));
        const sideName = `${source.name || source.preview || "任务"} · 侧聊`;
        setSideThread({ ...result.thread, name: sideName });
        setSideLiveText("");
        await bridge.call("thread/name/set", { threadId: result.thread.id, name: sideName });
      } else {
        selectedIdRef.current = result.thread.id;
        setThreadRoute(result.thread.meshId ?? result.thread.id, "push");
        setSelected(result.thread);
        setLiveText("");
        setSidebarOpen(false);
      }
      await loadThreads();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function deleteThread(thread: Thread) {
    if (!window.confirm(`永久删除“${thread.name || thread.preview || "该会话"}”？${thread.conversationKind === "worktree" ? "\n\n关联的 worktree 和 branch 会保留。" : ""}`)) return;
    setBusy(true);
    setError("");
    try {
      await bridge.call("thread/delete", { threadId: thread.id });
      if (selected?.id === thread.id) { selectedIdRef.current = null; setSelected(null); setGoal(null); setThreadRoute(null, "push"); }
      if (sideThread?.id === thread.id) closeSideThread();
      await loadThreads();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function sendTurn(overrideMessage?: string) {
    const message = (overrideMessage ?? draft).trim();
    if (!selected || !message || selectedSending) return;
    if (message === "/fork") {
      setDraft("");
      await forkThread(selected);
      return;
    }
    if (message === "/side") {
      setDraft("");
      await forkThread(selected, true);
      return;
    }
    if (message === "/new") {
      setDraft("");
      openNewThread(selected.cwd, selected.projectId ?? "");
      return;
    }
    if (message === "/project") {
      setDraft("");
      setProjectRoot(selected.cwd);
      setShowNewProject(true);
      return;
    }
    const optimisticId = clientId();
    setDraft("");
    setBusy(true);
    setLiveText("");
    setError("");
    setOptimisticMessages((current) => [...current, { id: optimisticId, threadId: selected.id, text: message, state: "sending" }]);
    setActivityLabels((current) => ({ ...current, [selected.id]: "正在发送消息" }));
    try {
      const result = await bridge.call<{ turn: Turn }>("turn/start", {
        threadId: selected.id,
        input: [{ type: "text", text: message, text_elements: [] }],
        ...(model ? { model } : {}),
        effort,
        ...turnPermissionParams(permission),
      });
      setOptimisticMessages((current) => current.map((item) => item.id === optimisticId ? { ...item, state: "sent", turnId: result.turn.id } : item));
      setActiveTurns((current) => ({ ...current, [selected.id]: result.turn.id }));
      setActivityLabels((current) => ({ ...current, [selected.id]: "Codex 正在思考" }));
      await refreshSelected();
    } catch (reason) {
      const messageText = reason instanceof Error ? reason.message : String(reason);
      setOptimisticMessages((current) => current.map((item) => item.id === optimisticId ? { ...item, state: "failed", error: messageText } : item));
      setActivityLabels((current) => {
        const next = { ...current };
        delete next[selected.id];
        return next;
      });
      setError(messageText);
    } finally {
      setBusy(false);
    }
  }

  async function sendSideTurn() {
    if (!sideThread || !sideDraft.trim() || sideBusy) return;
    const message = sideDraft.trim();
    const optimisticId = clientId();
    setSideDraft("");
    setSideBusy(true);
    setSideLiveText("");
    setError("");
    setOptimisticMessages((current) => [...current, { id: optimisticId, threadId: sideThread.id, text: message, state: "sending" }]);
    setActivityLabels((current) => ({ ...current, [sideThread.id]: "正在发送消息" }));
    try {
      const result = await bridge.call<{ turn: Turn }>("turn/start", {
        threadId: sideThread.id,
        input: [{ type: "text", text: message, text_elements: [] }],
        ...(model ? { model } : {}),
        effort,
        ...turnPermissionParams(permission),
      });
      setOptimisticMessages((current) => current.map((item) => item.id === optimisticId ? { ...item, state: "sent", turnId: result.turn.id } : item));
      setActiveTurns((current) => ({ ...current, [sideThread.id]: result.turn.id }));
      setActivityLabels((current) => ({ ...current, [sideThread.id]: "Codex 正在思考" }));
      await refreshSideThread();
    } catch (reason) {
      const messageText = reason instanceof Error ? reason.message : String(reason);
      setOptimisticMessages((current) => current.map((item) => item.id === optimisticId ? { ...item, state: "failed", error: messageText } : item));
      setActivityLabels((current) => {
        const next = { ...current };
        delete next[sideThread.id];
        return next;
      });
      setError(messageText);
    } finally {
      setSideBusy(false);
    }
  }

  function editFailedMessage(message: OptimisticMessage, side = false) {
    if (side) setSideDraft(message.text);
    else setDraft(message.text);
    setOptimisticMessages((current) => current.filter((item) => item.id !== message.id));
  }

  function closeSideThread() {
    sideThreadIdRef.current = null;
    setSideThread(null);
    setSideDraft("");
    setSideLiveText("");
    setSideHiddenTurnIds(new Set());
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
    const turnId = activeTurn?.id ?? activeTurns[selected.id];
    if (!turnId) return;
    await bridge.call("turn/interrupt", { threadId: selected.id, turnId });
  }

  async function selectMachine(machineId: string) {
    if (machineId === selectedMachineId) return;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.call<{ online: boolean }>("bridge/machine/select", { machineId });
      setSelectedMachineId(machineId);
      selectedIdRef.current = null;
      setSelected(null);
      setSideThread(null);
      setThreadRoute(null, "push");
      setThreads([]);
      setProjects([]);
      if (!result.online) throw new Error("机器当前离线");
      await Promise.all([loadThreads(), loadProjects()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  async function createEnrollment() {
    const result = await bridge.call<{ code: string; expiresAt: string }>("bridge/machine/enrollment/create");
    setEnrollment(result);
  }

  async function removeMachine(machineId: string) {
    if (!window.confirm("撤销这台机器？Agent 将立即断开。")) return;
    await bridge.call("bridge/machine/revoke", { machineId });
    await loadMachines();
  }

  async function openUsers() {
    setError("");
    try {
      const response = await fetch("/api/users");
      const body = await response.json() as { data?: UserSummary[]; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? "无法读取用户列表");
      setUsers(body.data);
      setShowUsers(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function setUserRole(userId: string, role: "admin" | "user") {
    const response = await fetch(`/api/users/${encodeURIComponent(userId)}/role`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const body = await response.json() as { updated?: boolean; error?: string };
    if (!response.ok || !body.updated) { setError(body.error ?? "更新用户角色失败"); return; }
    setUsers((current) => current.map((item) => item.id === userId ? { ...item, role } : item));
  }

  async function saveDefaultSettings() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaultPermission: permission,
          defaultModel: model || null,
          defaultReasoningEffort: effort,
        }),
      });
      const body = await response.json() as UserSettings & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "保存默认设置失败");
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function resolveRequest(request: ServerRequest, result: unknown) {
    bridge.respond(request.id, result);
    setRequests((current) => current.filter((item) => item.id !== request.id));
  }

  const selectedOptimistic = selected ? optimisticMessages.filter((message) => message.threadId === selected.id) : [];
  const sideOptimistic = sideThread ? optimisticMessages.filter((message) => message.threadId === sideThread.id) : [];
  const selectedSending = selectedOptimistic.some((message) => message.state === "sending");
  const sideSending = sideOptimistic.some((message) => message.state === "sending");
  const selectedRunning = Boolean(selected && (isThreadActive(selected) || activeTurns[selected.id] !== undefined || selectedSending));
  const sideRunning = Boolean(sideThread && (isThreadActive(sideThread) || activeTurns[sideThread.id] !== undefined || sideSending));

  useEffect(() => {
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
  }, [selected?.id, selected?.turns, selectedOptimistic.length, liveText, selectedRunning]);

  useEffect(() => {
    const timeline = sideTimelineRef.current;
    if (timeline) timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
  }, [sideThread?.id, sideThread?.turns, sideOptimistic.length, sideLiveText, sideRunning]);

  useEffect(() => { threadsRef.current = threads; }, [threads]);

  useEffect(() => {
    if (!zoomedImage) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setZoomedImage(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [zoomedImage]);

  if (authSession.isPending) return <main className="connect-page"><LoaderCircle className="spin" size={28} /></main>;
  if (!authSession.data) return <AuthPage />;
  const currentUserId = authSession.data.user.id;

  if (connection !== "ready" && !hasConnected) {
    return (
      <main className="connect-page">
        <section className="connect-card">
          <div className="brand-mark"><Command size={28} /></div>
          <p className="eyebrow">CODEX MESH</p>
          <h1>正在连接 Mesh</h1>
          <p className="muted">身份验证已完成，正在建立实时会话通道。</p>
          <button className="primary reconnect-action" onClick={() => bridge.connect()}><RefreshCw size={16} /> {connection === "connecting" ? "连接中…" : "重新连接"}</button>
          {connectionMessage && <p className="error-text">{connectionMessage}</p>}
        </section>
      </main>
    );
  }

  const running = selectedRunning;
  const visibleThreads = threads.filter((thread) => !searchQuery.trim() || `${thread.name ?? ""} ${thread.preview} ${thread.cwd}`.toLowerCase().includes(searchQuery.toLowerCase()));
  const threadGroups = groupThreads(visibleThreads, projects).filter((group) => !searchQuery.trim() || group.threads.length > 0);
  const selectedIsChat = selected ? isChatThread(selected) : false;
  const selectedStarted = selected ? isThreadStarted(selected) : false;

  return (
    <div className={`app-shell ${sideThread ? "with-side-chat" : ""}`}>
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <header className="sidebar-header">
          <div className="brand"><span className="brand-mark small"><Command size={18} /></span><span>Codex Mesh</span></div>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭侧边栏"><X size={19} /></button>
        </header>
        <div className="sidebar-create">
          <button className="new-chat" disabled={busy} onClick={() => void createChatSession()}><MessageCircle size={17} /> 新建聊天</button>
          <button className="task-button" onClick={() => openNewThread()}><MessageSquarePlus size={15} /> 新建任务</button>
          <button className="project-button" onClick={() => { setProjectRoot(selected && !selectedIsChat ? selected.cwd : newCwd); setShowNewProject(true); }}><Plus size={15} /> 新建项目</button>
        </div>
        <label className="thread-search"><Search size={14} /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索对话" /></label>
        <div className="thread-list">
          <div className="section-label"><span>项目与任务</span><button className="icon-button" onClick={() => { void loadProjects(); void loadThreads(); }} aria-label="刷新"><RefreshCw size={14} /></button></div>
          {threadGroups.map((group) => {
            const collapsed = !searchQuery.trim() && collapsedGroups.has(group.id);
            return <section className={`project-group ${collapsed ? "collapsed" : ""}`} key={group.id}>
              <div className="project-heading">
                <button className="project-toggle" onClick={() => toggleGroup(group.id)} aria-expanded={!collapsed} aria-label={`${collapsed ? "展开" : "折叠"}${group.name}`}>
                  {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  {group.kind === "chat" ? <MessageCircle size={13} /> : <FolderGit2 size={13} />}
                  <strong>{group.name}</strong><span>{group.threads.length}</span>
                </button>
                <button className="group-create" disabled={busy} onClick={() => group.kind === "chat" ? void createChatSession() : openNewThread(group.root ?? "", group.projectId ?? "")} title={group.kind === "chat" ? "新建聊天" : `在 ${group.name} 中新建任务`} aria-label={group.kind === "chat" ? "新建聊天" : `在 ${group.name} 中新建任务`}><Plus size={14} /></button>
              </div>
              {!collapsed && group.threads.map((thread) => (
                <div key={thread.id} className={`thread-row ${selected?.id === thread.id ? "active" : ""}`}>
                  <button className="thread-row-main" onClick={() => void selectThread(thread)}>
                    <span className={`status-dot ${isThreadActive(thread) ? "running" : ""}`} />
                    <span className="thread-copy">
                      <strong>{thread.name || thread.preview || (isChatThread(thread) ? "新聊天" : "新任务")}{thread.conversationKind === "side" && <em className="thread-kind side">侧聊</em>}{thread.conversationKind === "worktree" && <em className="thread-kind worktree">WT</em>}</strong>
                      <small>{thread.conversationKind === "worktree" ? <GitBranch size={11} /> : thread.forkedFromId && <GitFork size={11} />} {threadRelation(thread)}</small>
                    </span>
                    <time>{relativeTime(thread.updatedAt)}</time>
                  </button>
                  <div className="thread-row-actions">
                    <button disabled={busy || isThreadActive(thread)} onClick={() => void forkThread(thread)} title="Fork 会话" aria-label={`Fork ${thread.name || thread.preview || "会话"}`}><GitFork size={14} /></button>
                    {!isChatThread(thread) && <button disabled={busy || isThreadActive(thread)} onClick={() => void forkThread(thread, false, true)} title="Fork 到新 worktree" aria-label={`Worktree Fork ${thread.name || thread.preview || "会话"}`}><GitBranch size={14} /></button>}
                    <button className="danger" disabled={busy || isThreadActive(thread)} onClick={() => void deleteThread(thread)} title="删除会话" aria-label={`删除 ${thread.name || thread.preview || "会话"}`}><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </section>;
          })}
          {!threads.length && <p className="empty-list">还没有 Codex 任务。</p>}
        </div>
        <footer className="sidebar-footer"><span><i className={`online-dot ${machines.find((item) => item.id === selectedMachineId)?.online ? "" : "offline"}`} /> {machines.find((item) => item.id === selectedMachineId)?.name ?? "未选择机器"}</span><div>{currentRole === "admin" && <button onClick={() => void openUsers()}><Users size={13} /> 用户</button>}<button onClick={() => setShowSettings(true)}><Settings2 size={13} /> 设置</button><button onClick={() => setShowMachines(true)}><MonitorCog size={13} /> 机器</button><button onClick={() => void authClient.signOut()}><LogOut size={13} /> 退出</button></div></footer>
      </aside>

      {sidebarOpen && <button className="scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭侧边栏" />}

      <main className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开侧边栏"><Menu size={21} /></button>
          <div className="topbar-title">
            <strong>{selected?.name || selected?.preview || "选择一个任务"}</strong>
            {selected && <small>{selectedIsChat ? "独立聊天 Session" : threadRelation(selected, true)}</small>}
          </div>
          <select className="machine-select" value={selectedMachineId} onChange={(event) => void selectMachine(event.target.value)} aria-label="Codex 机器"><option value="">选择机器</option>{machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.online ? "●" : "○"} {machine.name}</option>)}</select>
          {selected && !selectedIsChat && <select className="project-select" value={selected.projectId ?? ""} onChange={(event) => void assignProject(event.target.value)} aria-label="所属项目"><option value="">按目录归类</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>}
          {selected && !selectedIsChat && <button className="icon-button" onClick={() => void browseFiles(selected.id)} aria-label="浏览项目文件" title="文件"><FolderOpen size={17} /></button>}
          {selected && selectedStarted && <button className={`icon-button ${goal ? "goal-active" : ""}`} onClick={() => { setGoalObjective(goal?.objective ?? ""); setGoalBudget(goal?.tokenBudget?.toString() ?? ""); setShowGoal(true); }} aria-label="目标" title="目标"><Target size={17} /></button>}
          {selected && <button className="icon-button" onClick={() => void renameThread()} aria-label="重命名" title="重命名"><Pencil size={16} /></button>}
          {selected && <button className="icon-button" onClick={() => void archiveThread()} aria-label="归档" title="归档"><Archive size={16} /></button>}
          {selected && <button className="icon-button" onClick={() => void forkThread(selected)} disabled={busy || running || !selectedStarted} aria-label="Fork 当前任务" title={selectedStarted ? "Fork 当前任务" : "发送第一条消息后可 Fork"}><GitFork size={17} /></button>}
          {selected && <button className="icon-button" onClick={() => void forkThread(selected, true)} disabled={busy || running || Boolean(sideThread) || !selectedStarted} aria-label="在侧边聊天中 Fork" title={selectedStarted ? "侧边聊天" : "发送第一条消息后可 Fork"}><PanelRightOpen size={17} /></button>}
          {selected && <span className={`run-state ${running ? "running" : ""}`}>{running && <LoaderCircle className="spin" size={12} />}{running ? "Codex 工作中" : "就绪"}</span>}
        </header>

        {connection !== "ready" && <div className="reconnect-banner"><RefreshCw size={15} /> {connectionMessage || "正在重新连接…"}</div>}
        {error && <div className="error-banner"><ShieldAlert size={16} /> <span>{error}</span><button onClick={() => setError("")}><X size={15} /></button></div>}

        {!selected ? (
          <section className="empty-state">
            <div className="empty-icon"><Bot size={38} /></div>
            <h2>在任何屏幕上继续 Codex 任务</h2>
            <p>查看实时输出、发送后续指令，并在命令越过权限边界时进行审批。</p>
            <div className="empty-actions"><button className="primary" disabled={busy} onClick={() => void createChatSession()}><MessageCircle size={17} /> 新建聊天</button><button className="secondary" onClick={() => openNewThread()}><MessageSquarePlus size={17} /> 新建任务</button></div>
          </section>
        ) : (
          <>
            <section className="timeline" ref={timelineRef}>
              {(selected.turns ?? []).flatMap((turn) => turn.items ?? []).map((item, index) => <TimelineItem item={item} threadId={selected.id} openFile={previewFile} openImage={(src, alt) => setZoomedImage({ src, alt })} key={item.id ?? `${item.type}-${index}`} />)}
              {selectedOptimistic.map((message) => <OptimisticUserMessage key={message.id} message={message} edit={() => editFailedMessage(message)} />)}
              {liveText && <article className="timeline-item assistant live"><div className="avatar"><Bot size={17} /></div><div className="bubble markdown"><MarkdownContent text={liveText} threadId={selected.id} openFile={previewFile} openImage={(src, alt) => setZoomedImage({ src, alt })} /><span className="cursor" /></div></article>}
              {running && !liveText && <ActivityIndicator label={requests.some((request) => requestThreadId(request) === selected.id) ? "等待你的确认" : activityLabels[selected.id] ?? "Codex 正在处理"} waiting={requests.some((request) => requestThreadId(request) === selected.id)} />}
              {!selected.turns?.some((turn) => turn.items?.length) && !selectedOptimistic.length && !liveText && !running && <div className="thread-empty"><Bot size={28} /><p>发送第一条指令开始这个任务。</p></div>}
            </section>

            <section className="composer-wrap">
              {goal && <GoalPill goal={goal} open={() => { setGoalObjective(goal.objective); setGoalBudget(goal.tokenBudget?.toString() ?? ""); setShowGoal(true); }} />}
              {requests.filter((request) => requestThreadId(request) !== sideThread?.id).map((request) => <ApprovalCard key={String(request.id)} request={request} resolve={(result) => resolveRequest(request, result)} />)}
              <div className="composer">
                {draft.startsWith("/") && <CommandMenu selectedIndex={slashCommandIndex} choose={(command) => void sendTurn(command)} />}
                <textarea value={draft} onChange={(event) => { const next = event.target.value; if (next.startsWith("/") && !draft.startsWith("/")) setSlashCommandIndex(0); setDraft(next); }} onKeyDown={(event) => {
                  if (draft.startsWith("/") && !event.nativeEvent.isComposing) {
                    if (event.key === "ArrowDown") { event.preventDefault(); setSlashCommandIndex((current) => (current + 1) % SLASH_COMMANDS.length); return; }
                    if (event.key === "ArrowUp") { event.preventDefault(); setSlashCommandIndex((current) => (current - 1 + SLASH_COMMANDS.length) % SLASH_COMMANDS.length); return; }
                    if (event.key === "Escape") { event.preventDefault(); setDraft(""); setSlashCommandIndex(0); return; }
                    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendTurn(SLASH_COMMANDS[slashCommandIndex].command); return; }
                  }
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendTurn(); }
                }} placeholder="给 Codex 发送后续指令…" rows={2} />
                <div className="composer-actions">
                  <div className="runtime-controls">
                    <select value={permission} onChange={(event) => setPermission(event.target.value as PermissionMode)} aria-label="权限" className={`permission-select permission-${permission}`}>
                      <option value="read-only">只读</option>
                      <option value="workspace-write">工作区</option>
                      <option value="full-access">完全访问</option>
                    </select>
                    <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="模型">
                      {models.map((item) => <option value={item.model} key={item.id}>{item.displayName}</option>)}
                    </select>
                    <select value={effort} onChange={(event) => setEffort(event.target.value as ReasoningEffort)} aria-label="推理强度">
                      {REASONING_EFFORTS.map((value) => <option value={value} key={value}>{value}</option>)}
                    </select>
                  </div>
                  {running ? <button className="stop-button" onClick={() => void interruptTurn()}><CircleStop size={17} /> 停止</button> : <button className="send-button" disabled={!draft.trim() || selectedSending} onClick={() => void sendTurn()} aria-label="发送"><Send size={18} /></button>}
                </div>
              </div>
            </section>
          </>
        )}
      </main>

      {sideThread && <aside className="side-chat">
        <header className="side-chat-header"><div><span>侧边聊天</span><strong>{sideThread.name || sideThread.preview || "Fork"}</strong></div><button className="icon-button" onClick={closeSideThread} aria-label="关闭侧边聊天"><X size={18} /></button></header>
        <section className="side-timeline" ref={sideTimelineRef}>
          {(sideThread.turns ?? []).filter((turn) => !sideHiddenTurnIds.has(turn.id)).flatMap((turn) => turn.items ?? []).map((item, index) => <TimelineItem item={item} threadId={sideThread.id} openFile={previewFile} openImage={(src, alt) => setZoomedImage({ src, alt })} key={item.id ?? `side-${item.type}-${index}`} />)}
          {sideOptimistic.map((message) => <OptimisticUserMessage key={message.id} message={message} edit={() => editFailedMessage(message, true)} />)}
          {sideLiveText && <article className="timeline-item assistant live"><div className="avatar"><Bot size={17} /></div><div className="bubble markdown"><MarkdownContent text={sideLiveText} threadId={sideThread.id} openFile={previewFile} openImage={(src, alt) => setZoomedImage({ src, alt })} /><span className="cursor" /></div></article>}
          {sideRunning && !sideLiveText && <ActivityIndicator label={requests.some((request) => requestThreadId(request) === sideThread.id) ? "等待你的确认" : activityLabels[sideThread.id] ?? "Codex 正在处理"} waiting={requests.some((request) => requestThreadId(request) === sideThread.id)} />}
        </section>
        <section className="side-composer-wrap">
          {requests.filter((request) => requestThreadId(request) === sideThread.id).map((request) => <ApprovalCard key={String(request.id)} request={request} resolve={(result) => resolveRequest(request, result)} />)}
          <div className="composer"><textarea value={sideDraft} disabled={sideRunning} onChange={(event) => setSideDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendSideTurn(); } }} placeholder={sideRunning ? "Codex 正在处理…" : "在 Fork 中继续探索…"} rows={2} /><div className="composer-actions"><small>独立 Fork，不影响主对话</small><button className="send-button" disabled={!sideDraft.trim() || sideBusy || sideRunning} onClick={() => void sendSideTurn()} aria-label="发送侧边消息"><Send size={17} /></button></div></div>
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
            <label htmlFor="new-permission">权限</label>
            <select id="new-permission" value={permission} onChange={(event) => setPermission(event.target.value as PermissionMode)}>
              <option value="read-only">只读（修改时询问）</option><option value="workspace-write">工作区写入</option><option value="full-access">完全访问（不询问）</option>
            </select>
            <label htmlFor="new-project">项目</label>
            <select id="new-project" value={newProjectId} onChange={(event) => {
              const projectId = event.target.value;
              setNewProjectId(projectId);
              const project = projects.find((item) => item.id === projectId);
              if (project?.roots[0]?.path) setNewCwd(project.roots[0].path);
            }}><option value="">不指定（按目录归类）</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
            <div className="safety-note"><ShieldAlert size={18} /><span>{permissionDescription(permission)}</span></div>
            <button className="primary" disabled={!newCwd.trim() || busy} onClick={() => void createThread()}>{busy ? "创建中…" : "创建任务"}</button>
          </section>
        </div>
      )}

      {showMachines && <div className="modal-layer" role="dialog" aria-modal="true" aria-label="Codex 机器"><section className="modal machine-modal"><header><MonitorCog size={20} /><h2>Codex 机器</h2><button className="icon-button" onClick={() => setShowMachines(false)}><X size={18} /></button></header><p className="muted">已登录为 {authSession.data.user.email}</p><div className="machine-list">{machines.map((machine) => <article key={machine.id}><i className={`online-dot ${machine.online ? "" : "offline"}`} /><span><strong>{machine.name}</strong><small>{machine.kind === "local" ? "控制面本机" : `${machine.agentVersion ?? "Agent"} · ${machine.online ? "在线" : "离线"}`}</small></span>{machine.kind === "agent" && <button onClick={() => void removeMachine(machine.id)}><Trash2 size={14} /></button>}</article>)}</div>{enrollment ? <div className="pairing-code"><small>在目标机器运行（10 分钟内有效）</small><code>npx codex-mesh pair --server {window.location.origin} --code {enrollment.code}</code><button onClick={() => void navigator.clipboard.writeText(`npx codex-mesh pair --server ${window.location.origin} --code ${enrollment.code}`)}><Copy size={14} /> 复制</button></div> : <button className="primary" onClick={() => void createEnrollment()}><Plus size={16} /> 添加机器</button>}</section></div>}

      {showSettings && <div className="modal-layer" role="dialog" aria-modal="true" aria-label="默认设置"><section className="modal settings-modal">
        <header><Settings2 size={20} /><h2>聊天默认设置</h2><button className="icon-button" onClick={() => setShowSettings(false)}><X size={18} /></button></header>
        <p className="muted">用于新聊天，也会立即应用到当前聊天的下一条消息。</p>
        <label htmlFor="default-permission">默认权限</label>
        <select id="default-permission" value={permission} onChange={(event) => setPermission(event.target.value as PermissionMode)}><option value="read-only">只读</option><option value="workspace-write">工作区写入</option><option value="full-access">完全访问</option></select>
        <div className={`permission-note permission-${permission}`}><ShieldAlert size={17} /><span>{permissionDescription(permission)}</span></div>
        <label htmlFor="default-model">默认模型</label>
        <select id="default-model" value={model} onChange={(event) => setModel(event.target.value)}>{models.map((item) => <option value={item.model} key={item.id}>{item.displayName}</option>)}</select>
        <label htmlFor="default-effort">默认 Thinking level</label>
        <select id="default-effort" value={effort} onChange={(event) => setEffort(event.target.value as ReasoningEffort)}>{REASONING_EFFORTS.map((value) => <option value={value} key={value}>{value}</option>)}</select>
        <button className="primary" disabled={busy} onClick={() => void saveDefaultSettings()}>{busy ? "保存中…" : "保存默认设置"}</button>
      </section></div>}

      {showUsers && <div className="modal-layer" role="dialog" aria-modal="true" aria-label="用户管理"><section className="modal user-modal"><header><Users size={20} /><h2>用户管理</h2><button className="icon-button" onClick={() => setShowUsers(false)}><X size={18} /></button></header><p className="muted">管理员可以查看账户并分配管理权限。</p><div className="user-list">{users.map((item) => <article key={item.id}><span><strong>{item.name}</strong><small>{item.email}</small></span><select value={item.role} disabled={item.id === currentUserId} onChange={(event) => void setUserRole(item.id, event.target.value as "admin" | "user")} aria-label={`${item.email} 的角色`}><option value="user">用户</option><option value="admin">管理员</option></select></article>)}</div></section></div>}

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

      {showGoal && <div className="modal-layer" role="dialog" aria-modal="true" aria-label="目标设置"><section className="modal goal-modal">
        <header><button className="icon-button" onClick={() => setShowGoal(false)}><ChevronLeft size={20} /></button><h2>{goal ? "管理目标" : "设定目标"}</h2></header>
        <label htmlFor="goal-objective">目标描述</label><textarea id="goal-objective" rows={4} maxLength={4000} value={goalObjective} onChange={(event) => setGoalObjective(event.target.value)} placeholder="描述希望 Codex 持续推进的结果…" />
        <label htmlFor="goal-budget">Token 预算（可选）</label><input id="goal-budget" type="number" min="1" value={goalBudget} onChange={(event) => setGoalBudget(event.target.value)} placeholder="例如 100000" />
        {goal && <div className="goal-stats"><span>已用 {formatNumber(goal.tokensUsed)} tokens</span><span>{formatDuration(goal.timeUsedSeconds)}</span></div>}
        <div className="goal-buttons">{goal && <button onClick={() => void clearGoal()}><Trash2 size={15} /> 清除</button>}{goal?.status === "active" && <button onClick={() => void saveGoal("paused")}>暂停</button>}<button className="primary" disabled={!goalObjective.trim() || busy} onClick={() => void saveGoal(goal?.status === "complete" ? "complete" : "active")}>{goal ? "保存" : "开始目标"}</button></div>
      </section></div>}

      {showFiles && <div className="file-layer" role="dialog" aria-modal="true" aria-label="文件浏览器"><section className="file-browser">
        <header><div><span>THREAD FILES</span><strong>{filePath}</strong></div><button className="icon-button" onClick={() => setShowFiles(false)} aria-label="关闭文件浏览"><X size={18} /></button></header>
        <div className="file-browser-body">
          <aside className="file-tree">
            {filePath !== "." && <button className="file-row" onClick={() => void browseFiles(fileThreadId, parentPath(filePath))}><ArrowLeft size={15} /><span>上一级</span></button>}
            {fileEntries.map((entry) => <button className="file-row" disabled={entry.type === "other"} key={entry.path} onClick={() => entry.type === "directory" ? void browseFiles(fileThreadId, entry.path) : void previewFile(fileThreadId, entry.path)}>{entry.type === "directory" ? <FolderOpen size={15} /> : isImagePath(entry.path) ? <Image size={15} /> : <FileText size={15} />}<span>{entry.name}</span>{entry.size !== null && entry.type === "file" && <small>{formatBytes(entry.size)}</small>}</button>)}
          </aside>
          <main className="file-preview">{fileBusy ? <div className="preview-empty"><RefreshCw className="spin" size={24} /> 读取中…</div> : filePreview ? <FilePreviewView preview={filePreview} openImage={(src, alt) => setZoomedImage({ src, alt })} /> : <div className="preview-empty"><FileText size={30} />选择文件查看内容</div>}</main>
        </div>
      </section></div>}
      {zoomedImage && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="图片放大预览" onClick={() => setZoomedImage(null)}><button className="lightbox-close" onClick={() => setZoomedImage(null)} aria-label="关闭图片预览"><X size={22} /></button><img src={zoomedImage.src} alt={zoomedImage.alt} onClick={(event) => event.stopPropagation()} /></div>}
    </div>
  );
}

function threadPermissionParams(permission: PermissionMode): { approvalPolicy: string; sandbox: string } {
  if (permission === "read-only") return { approvalPolicy: "on-request", sandbox: "read-only" };
  if (permission === "full-access") return { approvalPolicy: "never", sandbox: "danger-full-access" };
  return { approvalPolicy: "on-request", sandbox: "workspace-write" };
}

function clientId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function turnPermissionParams(permission: PermissionMode): { approvalPolicy: string; sandboxPolicy: Record<string, unknown> } {
  if (permission === "read-only") return { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } };
  if (permission === "full-access") return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
  return { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
}

function permissionDescription(permission: PermissionMode): string {
  if (permission === "read-only") return "Codex 可以读取文件；需要修改文件或执行越界操作时会请求批准。";
  if (permission === "full-access") return "Codex 可不经询问访问系统和网络。仅在可信任务中使用。";
  return "Codex 可以修改当前工作区；越过工作区边界时会请求批准。";
}

function AuthPage() {
  const [registering, setRegistering] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [authError, setAuthError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setAuthError("");
    const result = registering
      ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
      : await authClient.signIn.email({ email: email.trim(), password });
    if (result.error) setAuthError(result.error.message ?? "身份验证失败");
    setPending(false);
  }

  return <main className="connect-page"><section className="connect-card auth-card"><div className="brand-mark"><Command size={28} /></div><p className="eyebrow">CODEX MESH</p><h1>{registering ? "创建账户" : "登录"}</h1><p className="muted">统一管理你自己的 Codex 机器；OpenAI 登录凭据仍只保留在机器本地。</p><form onSubmit={(event) => void submit(event)}>{registering && <><label htmlFor="auth-name">显示名称</label><input id="auth-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></>}<label htmlFor="auth-email">邮箱</label><input id="auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /><label htmlFor="auth-password">密码</label><input id="auth-password" type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={registering ? "new-password" : "current-password"} required /><button className="primary" disabled={pending}>{pending ? <LoaderCircle className="spin" size={16} /> : null}{registering ? "注册" : "登录"}</button></form>{authError && <p className="error-text">{authError}</p>}<button className="auth-switch" onClick={() => { setRegistering((value) => !value); setAuthError(""); }}>{registering ? "已有账户？登录" : "还没有账户？注册"}</button></section></main>;
}

function TimelineItem({ item, threadId, openFile, openImage }: { item: ThreadItem; threadId: string; openFile: (threadId: string, path: string) => Promise<void>; openImage: (src: string, alt: string) => void }) {
  if (item.type === "userMessage") {
    const text = item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
    return <article className="timeline-item user"><div className="bubble">{text}</div></article>;
  }
  if (item.type === "agentMessage") {
    return <article className="timeline-item assistant"><div className="avatar"><Bot size={17} /></div><div className="message-body"><div className="bubble markdown"><MarkdownContent text={item.text ?? ""} threadId={threadId} openFile={openFile} openImage={openImage} /></div><div className="message-actions"><button onClick={() => void navigator.clipboard.writeText(item.text ?? "")} title="复制回复"><Copy size={14} /> 复制</button></div></div></article>;
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
    const alt = typeof item.revisedPrompt === "string" ? item.revisedPrompt : "Codex 生成的图片";
    return <article className="generated-image"><button type="button" onClick={() => openImage(source, alt)} title="点击放大"><img src={source} alt={alt} /><ZoomIn size={18} /></button></article>;
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "collabAgentToolCall") {
    return <details className="tool-card"><summary><Command size={15} /> {String(item.server ?? item.tool ?? item.type)} <span className="tool-status">{statusText(item.status)}</span></summary><pre>{JSON.stringify(item.arguments ?? item.result ?? item, null, 2)}</pre></details>;
  }
  if (item.type === "plan") {
    return <article className="plan-card"><strong>计划</strong><div className="markdown"><MarkdownContent text={item.text ?? ""} threadId={threadId} openFile={openFile} openImage={openImage} /></div></article>;
  }
  return null;
}

function MarkdownContent({ text, threadId, openFile, openImage }: { text: string; threadId: string; openFile: (threadId: string, path: string) => Promise<void>; openImage: (src: string, alt: string) => void }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url) => isSafeMarkdownUrl(url) ? url : ""} components={{
    a: ({ href, children }) => {
      const path = href ? localFilePath(href) : null;
      return path
        ? <a href={href} onClick={(event) => { event.preventDefault(); void openFile(threadId, path); }}>{children}</a>
        : <a href={href} target="_blank" rel="noreferrer">{children}</a>;
    },
    img: ({ src, alt }) => {
      if (!src) return null;
      const path = localFilePath(src);
      return path
        ? <button type="button" className="markdown-local-image" onClick={() => void openFile(threadId, path)} title="在文件预览中打开"><Image size={18} /><span>{alt || path}</span></button>
        : <button type="button" className="markdown-image" onClick={() => openImage(src, alt ?? "图片")} title="点击放大"><img src={src} alt={alt ?? ""} /><ZoomIn size={18} /></button>;
    },
  }}>{text}</ReactMarkdown>;
}

function OptimisticUserMessage({ message, edit }: { message: OptimisticMessage; edit: () => void }) {
  return <article className={`timeline-item user optimistic ${message.state}`}><div className="user-message-wrap"><div className="bubble">{message.text}</div>{message.state === "sending" && <span className="delivery-state sending" title="正在发送"><LoaderCircle className="spin" size={15} /></span>}{message.state === "failed" && <button className="delivery-state failed" onClick={edit} title={message.error ? `发送失败：${message.error}。点击重新编辑` : "发送失败，点击重新编辑"} aria-label="发送失败，重新编辑"><X size={15} /></button>}</div></article>;
}

function ActivityIndicator({ label, waiting = false }: { label: string; waiting?: boolean }) {
  return <article className={`timeline-item assistant activity ${waiting ? "waiting" : ""}`} aria-live="polite"><div className="avatar"><Bot size={17} /></div><div className="activity-bubble">{waiting ? <ShieldAlert size={15} /> : <LoaderCircle className="spin" size={15} />}<span>{label}</span>{!waiting && <i><b /><b /><b /></i>}</div></article>;
}

function GoalPill({ goal, open }: { goal: ThreadGoal; open: () => void }) {
  const complete = goal.status === "complete";
  const percent = goal.tokenBudget ? Math.min(100, Math.round(goal.tokensUsed / goal.tokenBudget * 100)) : null;
  return <button className={`goal-pill ${complete ? "complete" : ""}`} onClick={open}><span className="goal-icon">{complete ? <CheckCircle2 size={16} /> : <Target size={16} />}</span><span><strong>{complete ? "目标已达成" : goal.objective}</strong><small>{formatNumber(goal.tokensUsed)} tokens · {formatDuration(goal.timeUsedSeconds)}{percent !== null ? ` · ${percent}%` : ""}</small></span></button>;
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

function CommandMenu({ selectedIndex, choose }: { selectedIndex: number; choose: (command: string) => void }) {
  return <div className="command-menu" role="listbox" aria-label="Slash 命令">{SLASH_COMMANDS.map((item, index) => <button type="button" role="option" aria-selected={index === selectedIndex} className={index === selectedIndex ? "selected" : ""} key={item.command} onMouseEnter={() => { /* Keep keyboard selection stable while the pointer passes over the menu. */ }} onClick={() => choose(item.command)}><code>{item.command}</code><span><strong>{item.label}</strong><small>{item.detail}</small></span>{index === selectedIndex && <kbd>↵</kbd>}</button>)}</div>;
}

function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="empty-diff">没有可显示的 diff</div>;
  return <pre className="diff-view">{diff.split("\n").map((line, index) => <span className={line.startsWith("+") && !line.startsWith("+++") ? "diff-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-delete" : line.startsWith("@@") ? "diff-hunk" : ""} key={`${index}-${line.slice(0, 20)}`}>{line || " "}</span>)}</pre>;
}

function FilePreviewView({ preview, openImage }: { preview: FilePreview; openImage: (src: string, alt: string) => void }) {
  const language = languageFromPath(preview.path);
  return <article className="preview-content"><header><strong>{preview.path}</strong><div className="preview-meta">{preview.kind === "text" && <span>{language}</span>}<small>{formatBytes(preview.size)}{preview.mimeType ? ` · ${preview.mimeType}` : ""}</small></div></header>{preview.kind === "image" && preview.dataUrl ? <button type="button" className="image-preview" onClick={() => openImage(preview.dataUrl as string, preview.path)} title="点击放大"><img src={preview.dataUrl} alt={preview.path} /><span><ZoomIn size={17} /> 点击放大</span></button> : preview.kind === "text" ? <HighlightedFile content={preview.content ?? ""} language={language} /> : <div className="preview-empty">二进制文件不支持文本预览</div>}</article>;
}

function HighlightedFile({ content, language }: { content: string; language: Language }) {
  const code = content.endsWith("\n") ? content.slice(0, -1) : content;
  const shouldHighlight = code.length <= 250_000;
  if (!shouldHighlight) return <pre className="source-code plain-source">{code}</pre>;
  return <Highlight theme={themes.oneDark} code={code} language={language}>{({ className, style, tokens, getLineProps, getTokenProps }) => (
    <pre className={`${className} source-code`} style={{ ...style, background: "transparent" }}>
      {tokens.map((line, index) => {
        const lineProps = getLineProps({ line });
        return <span {...lineProps} className={`${lineProps.className} source-line`} key={index}><span className="line-number">{index + 1}</span><span className="line-code">{line.map((token, tokenIndex) => <span {...getTokenProps({ token })} key={tokenIndex} />)}</span></span>;
      })}
    </pre>
  )}</Highlight>;
}

function requestThreadId(request: ServerRequest): string | undefined {
  return typeof request.params.threadId === "string" ? request.params.threadId : undefined;
}

function reconcileOptimisticMessage(thread: Thread, setMessages: React.Dispatch<React.SetStateAction<OptimisticMessage[]>>): void {
  const materializedTurns = new Set((thread.turns ?? []).filter((turn) => (turn.items ?? []).some((item) => item.type === "userMessage")).map((turn) => turn.id));
  setMessages((current) => current.filter((message) => message.threadId !== thread.id || message.state === "failed" || !message.turnId || !materializedTurns.has(message.turnId)));
}

function activityLabel(item?: ThreadItem): string {
  if (!item) return "Codex 正在处理";
  if (item.type === "commandExecution") return "正在执行命令";
  if (item.type === "fileChange") return "正在修改文件";
  if (item.type === "reasoning") return "Codex 正在思考";
  if (item.type === "agentMessage") return "正在生成回复";
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "collabAgentToolCall") return "正在调用工具";
  if (item.type === "userMessage") return "消息已送达，Codex 正在思考";
  return "Codex 正在处理";
}

function localFilePath(href: string): string | null {
  let value = href.trim();
  if (!value || value.startsWith("#") || /^(https?:|mailto:|tel:|data:|blob:)/i.test(value)) return null;
  if (value.startsWith("file://")) {
    try { value = new URL(value).pathname; } catch { return null; }
  } else if (value.startsWith("sandbox:")) {
    value = value.slice("sandbox:".length);
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-zA-Z]:[\\/]/.test(value)) {
    return null;
  }
  value = value.split("#", 1)[0];
  try { value = decodeURIComponent(value); } catch { /* Keep the original path if it is not URI encoded. */ }
  value = value.replace(/:(\d+)(?::\d+)?$/, "");
  return value || null;
}

function isSafeMarkdownUrl(url: string): boolean {
  return localFilePath(url) !== null || /^(https?:|mailto:|tel:|data:image\/|blob:|#)/i.test(url);
}

function threadIdFromLocation(): string | null {
  const match = window.location.pathname.match(/^\/thread\/([^/]+)\/?$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function setThreadRoute(threadId: string | null, mode: "push" | "replace"): void {
  const path = threadId ? `/thread/${encodeURIComponent(threadId)}` : "/";
  if (window.location.pathname === path) return;
  window.history[mode === "push" ? "pushState" : "replaceState"](null, "", path);
}

function isThreadActive(thread: Thread): boolean {
  return typeof thread.status === "object" && thread.status !== null && (thread.status as { type?: string }).type === "active";
}

function isThreadStarted(thread: Thread): boolean {
  return (thread.turns ?? []).some((turn) => (turn.items ?? []).length > 0);
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

function threadRelation(thread: Thread, full = false): string {
  if (thread.conversationKind === "side") return `侧边 · ${thread.branch ?? thread.gitInfo?.branch ?? shortPath(thread.cwd)}`;
  const branch = thread.branch ?? thread.gitInfo?.branch;
  if (thread.conversationKind === "worktree") {
    const path = full ? thread.worktreePath ?? thread.cwd : shortPath(thread.worktreePath ?? thread.cwd);
    const main = thread.mainRoot ? (full ? thread.mainRoot : shortPath(thread.mainRoot)) : "主目录";
    return `${branch ?? "worktree"} · ${path} ← ${main}`;
  }
  const path = full ? thread.cwd : shortPath(thread.cwd);
  return branch ? `${branch} · ${path}` : path;
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

function languageFromPath(path: string): Language {
  const fileName = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (fileName === "dockerfile") return "docker";
  if (fileName === "makefile") return "makefile";
  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
  return ({
    js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
    py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
    c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
    php: "php", swift: "swift", scala: "scala", sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
    json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "markup",
    html: "markup", htm: "markup", vue: "markup", svelte: "markup", svg: "markup",
    css: "css", scss: "scss", sass: "sass", less: "less",
    md: "markdown", mdx: "markdown", sql: "sql", graphql: "graphql", gql: "graphql",
    diff: "diff", patch: "diff", ini: "ini", env: "bash",
  } as Record<string, Language>)[extension] ?? "text";
}

function isChatThread(thread: Thread): boolean {
  return thread.cwd.split(/[\\/]/).some((segment) => CHAT_WORKSPACE_SEGMENTS.has(segment));
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatNumber(value: number): string { return new Intl.NumberFormat("zh-CN").format(value); }
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function fileChangeKind(kind: string | { type?: string }): string {
  return typeof kind === "string" ? kind : kind.type ?? "update";
}

function groupThreads(threads: Thread[], projects: Project[]): ThreadGroup[] {
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const groups = new Map<string, ThreadGroup>();
  groups.set("chat", { id: "chat", name: "聊天", threads: [], position: -1, kind: "chat" });
  for (const project of projects) {
    groups.set(`project:${project.id}`, {
      id: `project:${project.id}`,
      name: project.name,
      threads: [],
      position: project.position,
      kind: "project",
      root: project.roots[0]?.path,
      projectId: project.id,
    });
  }
  for (const thread of threads) {
    if (isChatThread(thread)) {
      groups.get("chat")?.threads.push(thread);
      continue;
    }
    const project = thread.projectId ? projectMap.get(thread.projectId) : undefined;
    const relationshipRoot = thread.conversationKind === "worktree" && thread.mainRoot ? thread.mainRoot : thread.cwd;
    const id = project ? `project:${project.id}` : `cwd:${relationshipRoot}`;
    const name = project?.name ?? shortPath(relationshipRoot);
    const group = groups.get(id) ?? { id, name, threads: [], position: project?.position ?? Number.MAX_SAFE_INTEGER, kind: project ? "project" : "directory", root: project?.roots[0]?.path ?? relationshipRoot, projectId: project?.id };
    group.threads.push(thread);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => a.position - b.position || (b.threads[0]?.updatedAt ?? 0) - (a.threads[0]?.updatedAt ?? 0));
}
