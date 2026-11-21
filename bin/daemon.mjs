import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const MINOR = "0.26";
const TARGET = `${process.platform}-${process.arch}`;
const EXECUTABLE = process.platform === "win32" ? "letmeknow.exe" : "letmeknow";
const INVITE_WAIT = 180_000;
const DEBOUNCE = 2000;
const MAX_LINE = 12 * 1024;
const MAX_BATCH_BYTES = 50 * 1024;
const MAX_BATCH_LINES = 2000;
const POLL_MS = 2000;
const run = promisify(execFile);

export function stateDir() {
  return join(homedir(), ".local", "state", "agy-letmeknow");
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await rename(tmp, filePath);
}

export function capLine(line) {
  return line.length > MAX_LINE
    ? `${line.slice(0, MAX_LINE)} [letmeknow: line truncated; the session's log has the whole line.]`
    : line;
}

export function capLines(lines) {
  const kept = [];
  let bytes = 0;
  let truncated = false;
  for (const line of lines) {
    const add = Buffer.byteLength(line, "utf8") + (kept.length ? 1 : 0);
    if (kept.length >= MAX_BATCH_LINES || (kept.length > 0 && bytes + add > MAX_BATCH_BYTES)) {
      truncated = true;
      break;
    }
    kept.push(line);
    bytes += add;
  }
  if (truncated) kept.push("[letmeknow: output truncated; the rest is in the session's log.]");
  return kept;
}

export function capBatch(lines) {
  return capLines(lines).join("\n");
}

function highestMinor(versions) {
  return versions
    .filter(v => v.startsWith(`${MINOR}.`) && /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => Number(a.split(".")[2]) - Number(b.split(".")[2]))
    .at(-1);
}

async function cachedIn(dir) {
  if (!existsSync(dir)) return undefined;
  const versions = (await readdir(dir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, "bin", EXECUTABLE)))
    .map(entry => entry.name);
  const version = highestMinor(versions);
  return version ? { version, executable: join(dir, version, "bin", EXECUTABLE) } : undefined;
}

export async function installBinary(warn = () => {}) {
  const cache = join(homedir(), ".cache", "agy-letmeknow", TARGET);
  const fallbackCache = join(homedir(), ".cache", "pi-letmeknow", TARGET);
  await mkdir(cache, { recursive: true });
  let versions;
  let latest;
  try {
    const found = await fetch(`https://registry.npmjs.org/@letmeknow/${TARGET}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!found.ok) throw new Error(`npm has no @letmeknow/${TARGET} (${found.status})`);
    ({ versions } = await found.json());
  } catch (offline) {
    const primary = await cachedIn(cache);
    const fallback = await cachedIn(fallbackCache);
    const best = primary && fallback
      ? (Number(fallback.version.split(".")[2]) > Number(primary.version.split(".")[2]) ? fallback : primary)
      : (primary ?? fallback);
    if (!best) throw offline;
    warn(`letmeknow: cannot look for a newer ${MINOR} release (${offline.message}); running cached ${best.version}`);
    return best.executable;
  }
  latest = highestMinor(Object.keys(versions));
  if (!latest) throw new Error(`letmeknow has no ${MINOR} release for ${TARGET}`);
  const dest = join(cache, latest);
  const executable = join(dest, "bin", EXECUTABLE);
  if (existsSync(executable)) return executable;
  const { tarball, integrity } = versions[latest].dist;
  const fetched = await fetch(tarball);
  if (!fetched.ok) throw new Error(`cannot fetch letmeknow ${latest} (${fetched.status})`);
  const bytes = Buffer.from(await fetched.arrayBuffer());
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) {
    throw new Error(`letmeknow ${latest} does not match its integrity`);
  }
  const tmp = await mkdtemp(join(cache, "new-"));
  try {
    await writeFile(join(tmp, "package.tgz"), bytes);
    // Relative tar args avoid GNU tar on Windows treating `C:` as a remote host.
    await run("tar", ["-xzf", "package.tgz"], { cwd: tmp });
    await access(join(tmp, "package", "bin", EXECUTABLE));
    try {
      await rename(join(tmp, "package"), dest);
    } catch (error) {
      if (!existsSync(executable)) throw error;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return executable;
}

async function lmkJson(executable, args, env, timeout = 0) {
  return JSON.parse((await run(executable, args, { env, timeout })).stdout);
}

async function inviteFrom(executable, sibling, group, use, signal, env) {
  const invite = async () => (await lmkJson(executable, ["--session", sibling.fp, "invite", "--group", group], env, INVITE_WAIT)).link;
  if (sibling.running) return void (await use(await invite()));
  const listen = spawn(executable, ["--session", sibling.fp, "listen"], { stdio: ["ignore", "pipe", "pipe"], signal, env });
  try {
    await new Promise((resolve, reject) => {
      let errors = "";
      listen.stderr.on("data", chunk => (errors += chunk));
      listen.on("error", reject);
      listen.on("exit", code => reject(new Error(`session ${sibling.fp} stopped (exit ${code}): ${errors.trim()}`)));
      setTimeout(() => reject(new Error(`session ${sibling.fp} was not ready within ${INVITE_WAIT / 1000} s`)), INVITE_WAIT).unref();
      createInterface({ input: listen.stdout }).on("line", line => {
        if (JSON.parse(line).type === "ready") resolve();
      });
    });
    await use(await invite());
  } finally {
    listen.kill();
  }
}

export async function joinListed(executable, fp, groups, signal, env) {
  if (!groups.length) return { joined: [], warnings: [] };
  const { sessions } = await lmkJson(executable, ["sessions"], env);
  const joined = [];
  const warnings = [];
  for (const group of groups) {
    if (sessions.find(s => s.fp === fp)?.groups?.includes(group)) {
      joined.push(group);
      continue;
    }
    const siblings = sessions
      .filter(s => s.fp !== fp && s.groups?.includes(group))
      .sort((a, b) => Number(!!b.running) - Number(!!a.running));
    const failures = [];
    for (const sibling of siblings) {
      signal.throwIfAborted();
      try {
        await inviteFrom(executable, sibling, group, link => lmkJson(executable, ["--session", fp, "join", link], env), signal, env);
        joined.push(group);
        break;
      } catch (error) {
        failures.push(`${sibling.fp}: ${error.stderr?.trim() || error.message}`);
      }
    }
    if (failures.length === siblings.length) {
      warnings.push(`letmeknow: cannot join ${group} through a session of this machine${failures.length ? ` (${failures.join("; ")})` : ""}`);
    }
  }
  return { joined, warnings };
}

async function waitForStaleConversationDaemon(dir, conversationId) {
  if (!existsSync(dir)) return;
  for (const name of await readdir(dir)) {
    if (!name.startsWith("run-") || !name.endsWith(".json")) continue;
    let other;
    try {
      other = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (other.conversationId !== conversationId || isAlive(other.agyPid) || !isAlive(other.daemonPid)) continue;
    if (process.platform !== "win32") {
      try {
        process.kill(other.daemonPid, "SIGTERM");
      } catch {}
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isAlive(other.daemonPid)) {
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

async function killChildCleanly(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  if (process.platform === "win32") {
    child.kill();
    await Promise.race([exited, new Promise(r => setTimeout(r, 2000))]);
    return;
  }
  child.kill("SIGTERM");
  const done = await Promise.race([exited.then(() => true), new Promise(r => setTimeout(() => r(false), 2000))]);
  if (!done && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise(r => setTimeout(r, 1000))]);
  }
}

function bearerMatches(header, token) {
  if (typeof header !== "string") return false;
  const expected = `Bearer ${token}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error("request too large");
  }
  return raw ? JSON.parse(raw) : {};
}

async function saveSessionFp(sessionsFile, conversationId, fp) {
  let sessions = {};
  if (existsSync(sessionsFile)) {
    try {
      sessions = JSON.parse(await readFile(sessionsFile, "utf8"));
    } catch {
      sessions = {};
    }
  }
  if (sessions[conversationId]?.fp === fp) return;
  sessions[conversationId] = { fp };
  await writeJsonAtomic(sessionsFile, sessions);
}

async function runDaemon(agyPid, conversationId) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const runPath = join(dir, `run-${agyPid}.json`);
  const errPath = join(dir, `err-${agyPid}.txt`);
  const sessionsFile = join(dir, "sessions.json");
  const configFile = process.env.AGY_LETMEKNOW_CONFIG || join(homedir(), ".gemini", "letmeknow.json");

  const {
    LETMEKNOW_SESSION: _s,
    AGY_LETMEKNOW_JOIN: envJoin,
    AGY_LETMEKNOW_ATTACH: envAttach,
    AGY_LETMEKNOW_READY_FILE: readyFile,
    AGY_LETMEKNOW_PROMPT_FILE: _p,
    ...childEnv
  } = process.env;

  const stop = new AbortController();
  const warnings = [];
  let listenChild;
  let server;
  let pollTimer;
  let debounceTimer;
  let shuttingDown = false;

  let fp = "";
  let bin = "";
  let log = "";
  let attached = false;
  let activeGroups = [];
  let bound = false;
  let lsAddress = "";
  let csrfToken = "";
  let agyExe = "";
  let waiting = [];
  let queued = [];
  let deliveryChain = Promise.resolve();

  const emitReadyFile = async payload => {
    if (readyFile) await writeJsonAtomic(readyFile, payload);
  };

  const deliver = batch => {
    if (!batch || !bound) return;
    const cmd = agyExe && existsSync(agyExe) ? agyExe : "agy";
    const env = { ...childEnv, ANTIGRAVITY_LS_ADDRESS: lsAddress, ANTIGRAVITY_CSRF_TOKEN: csrfToken };
    deliveryChain = deliveryChain
      .then(() => run(cmd, ["agentapi", "send-message", "--title=letmeknow", conversationId, batch], { env, timeout: 30_000 }))
      .catch(() => {});
  };

  const flushWaiting = () => {
    debounceTimer = undefined;
    const lines = waiting;
    waiting = [];
    if (!lines.length) return;
    if (bound) deliver(capBatch(lines));
    else queued.push(...lines);
  };

  const wake = line => {
    waiting.push(capLine(line));
    if (debounceTimer) return;
    debounceTimer = setTimeout(flushWaiting, DEBOUNCE);
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(pollTimer);
    clearTimeout(debounceTimer);
    stop.abort();
    if (server) server.close();
    await killChildCleanly(listenChild);
    rmSync(runPath, { force: true });
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  pollTimer = setInterval(() => {
    if (!isAlive(agyPid)) void shutdown();
  }, POLL_MS);

  try {
    await waitForStaleConversationDaemon(dir, conversationId);
    const executable = await installBinary(msg => warnings.push(msg));
    const fileConfig = existsSync(configFile) ? JSON.parse(await readFile(configFile, "utf8")) : {};
    const groups = envJoin !== undefined ? envJoin.split(",").map(s => s.trim()).filter(Boolean) : (fileConfig.join ?? []);
    const attach = envAttach !== undefined ? (envAttach || undefined) : fileConfig.attach;
    const savedSessions = existsSync(sessionsFile) ? JSON.parse(await readFile(sessionsFile, "utf8")) : {};
    const savedFp = savedSessions[conversationId]?.fp;

    const tryStart = args => new Promise((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
      let errors = "";
      let settled = false;
      child.stderr.on("data", chunk => (errors = (errors + chunk).slice(-2000)));
      child.on("error", err => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      child.on("exit", code => {
        if (!settled) {
          settled = true;
          reject(new Error(errors.trim() || `exit ${code}`));
          return;
        }
        if (shuttingDown || listenChild !== child) return;
        const again = fp && bin ? `: ${bin} --session ${fp} ${attached ? "attach" : "listen"}` : ".";
        const notice = `letmeknow stopped (exit ${code}): ${errors.trim()}\nNothing reaches you until it runs again${again}`;
        if (bound) deliver(notice);
        else queued.push(notice);
      });
      createInterface({ input: child.stdout }).on("line", line => {
        const event = JSON.parse(line);
        if (event.type !== "ready") {
          wake(line);
          return;
        }
        fp = event.fp;
        bin = event.bin || executable;
        log = event.log || "";
        attached = args.includes("attach");
        if (!settled) {
          settled = true;
          listenChild = child;
          resolve();
          return;
        }
        void saveSessionFp(sessionsFile, conversationId, fp).catch(() => {});
        if (existsSync(runPath)) {
          try {
            const cur = JSON.parse(readFileSync(runPath, "utf8"));
            cur.fp = fp;
            cur.bin = bin;
            cur.log = log;
            void writeJsonAtomic(runPath, cur).catch(() => {});
          } catch {}
        }
      });
    });

    const startWithFallbacks = async () => {
      if (savedFp && savedFp !== attach) {
        try {
          await tryStart(["--session", savedFp, "listen"]);
          return;
        } catch (err) {
          warnings.push(`letmeknow: not ${savedFp} again (${err.message})`);
        }
      }
      if (attach) {
        try {
          await tryStart(["--session", attach, "attach"]);
          return;
        } catch (err) {
          warnings.push(`letmeknow: not attached to ${attach} (${err.message}); starting a new letmeknow session`);
        }
      }
      await tryStart(["listen"]);
    };

    await startWithFallbacks();
    await saveSessionFp(sessionsFile, conversationId, fp);

    let joinError;
    try {
      const joined = await joinListed(bin, fp, groups, stop.signal, childEnv);
      activeGroups = joined.joined;
      warnings.push(...joined.warnings);
    } catch (err) {
      if (shuttingDown) return;
      joinError = err;
      warnings.push(`letmeknow: joining groups failed: ${err.message}`);
    }
    if (shuttingDown) return;

    const ipcToken = randomBytes(24).toString("hex");
    server = createServer(async (req, res) => {
      if (!bearerMatches(req.headers.authorization, ipcToken)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/bind") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      try {
        const body = await readBody(req);
        if (!body.lsAddress || !body.csrfToken) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "lsAddress and csrfToken required" }));
          return;
        }
        const wasBound = bound;
        lsAddress = body.lsAddress;
        csrfToken = body.csrfToken;
        agyExe = body.agyExe || "agy";
        bound = true;
        if (!wasBound && existsSync(runPath)) {
          const cur = JSON.parse(await readFile(runPath, "utf8"));
          cur.bound = true;
          await writeJsonAtomic(runPath, cur);
        }
        let drained = [];
        if (body.flush !== false) {
          if (!wasBound && waiting.length) {
            clearTimeout(debounceTimer);
            debounceTimer = undefined;
            queued.push(...waiting);
            waiting = [];
          }
          if (queued.length) drained = capLines(queued.splice(0));
        } else if (queued.length) {
          deliver(capBatch(queued.splice(0)));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, fp, groups: activeGroups, queued: drained }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const ipcPort = server.address().port;

    await writeJsonAtomic(runPath, {
      agyPid,
      daemonPid: process.pid,
      conversationId,
      fp,
      bin,
      log,
      groups: activeGroups,
      warnings,
      bound: false,
      ipcPort,
      ipcToken,
      introInjected: false,
      promptInjected: false,
      attached,
    });

    if (joinError) {
      await emitReadyFile({ fp, conversationId, groups: [], warnings, error: joinError.message });
    } else {
      await emitReadyFile({ fp, conversationId, groups: activeGroups, warnings });
    }
  } catch (err) {
    await writeFile(errPath, `${err.message}\n`, { mode: 0o600 }).catch(() => {});
    await emitReadyFile({ error: err.message }).catch(() => {});
    await killChildCleanly(listenChild);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  const agyPid = Number(process.argv[2]);
  const conversationId = process.argv[3];
  if (!Number.isInteger(agyPid) || agyPid <= 0 || !conversationId) {
    process.exit(1);
  }
  void runDaemon(agyPid, conversationId);
}
