#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isAlive, stateDir } from "./daemon.mjs";

export function findActiveRun(conversationId) {
  const dir = stateDir();
  if (!conversationId || !existsSync(dir)) return undefined;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("run-") || !name.endsWith(".json")) continue;
    let state;
    try {
      state = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (state.conversationId === conversationId && isAlive(state.daemonPid) && isAlive(state.agyPid)) {
      return state;
    }
  }
  return undefined;
}

async function bindSession(state, flush) {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const agyExe = exe && existsSync(exe) ? exe : "agy";
  const res = await fetch(`http://127.0.0.1:${state.ipcPort}/bind`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.ipcToken}`,
    },
    body: JSON.stringify({
      lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS,
      csrfToken: process.env.ANTIGRAVITY_CSRF_TOKEN,
      agyExe,
      flush,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `bind failed (${res.status})`);
  return data;
}

async function main() {
  const args = process.argv.slice(2);
  const conversationId = process.env.ANTIGRAVITY_CONVERSATION_ID;
  const state = findActiveRun(conversationId);
  if (!state) {
    console.error("agy-letmeknow: no active letmeknow session for this Antigravity conversation");
    process.exit(1);
  }

  const isBind = args[0] === "bind";
  const hasBindEnv = Boolean(process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN);
  if (isBind && !hasBindEnv) {
    console.error("agy-letmeknow: ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN are required to bind");
    process.exit(1);
  }

  let bindResult;
  if (hasBindEnv) {
    bindResult = await bindSession(state, isBind);
  }

  if (isBind) {
    const groups = bindResult.groups?.length ? bindResult.groups.join(", ") : "none";
    console.log(`Bound letmeknow session ${bindResult.fp} (groups: ${groups})`);
    if (bindResult.queued?.length) {
      console.log(bindResult.queued.join("\n"));
    }
    process.exit(0);
  }

  const { LETMEKNOW_SESSION: _, ...env } = process.env;
  const child = spawn(state.bin, ["--session", state.fp, ...args], { stdio: "inherit", env });
  child.on("error", err => {
    console.error(`agy-letmeknow: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  await main();
}
