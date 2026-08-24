import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalRpcHandler } from "../server/dist/local-rpc.js";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "codex-mesh-worktree-e2e-"));
const repo = join(root, "repository");
try {
  await exec("git", ["init", repo]);
  await writeFile(join(repo, "README.md"), "worktree e2e\n");
  await exec("git", ["-C", repo, "add", "README.md"]);
  await exec("git", ["-C", repo, "-c", "user.name=Codex Mesh", "-c", "user.email=e2e@mesh.test", "commit", "-m", "initial"]);
  const appServer = { request: async (method) => method === "thread/read" ? { thread: { cwd: repo } } : {} };
  const result = await createLocalRpcHandler(appServer)("bridge/git/worktree/create", { threadId: "e2e-thread", branch: "codex/worktree-e2e" });
  const branch = (await exec("git", ["-C", result.worktreePath, "branch", "--show-current"])).stdout.trim();
  if (branch !== result.branch || result.mainRoot !== repo) throw new Error("worktree relationship mismatch");
  console.log(JSON.stringify({ ok: true, branch, mainRoot: result.mainRoot, worktreePath: result.worktreePath }));
} finally {
  await rm(root, { recursive: true, force: true });
}
