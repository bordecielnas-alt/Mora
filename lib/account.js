// Connexion du compte Claude (abonnement) depuis l'interface.
// Mora embarque Claude Code (dépendance npm) et pilote sa connexion : `claude auth login`.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** La commande claude : celle embarquée dans node_modules, sinon celle du système. */
export function claudeBin() {
  if (process.env.MORA_CLAUDE_BIN) return process.env.MORA_CLAUDE_BIN;
  const local = path.join(root, "node_modules", ".bin", IS_WIN ? "claude.cmd" : "claude");
  return fs.existsSync(local) ? local : "claude";
}

/** Sans clé API dans l'environnement, Claude Code utilise la connexion à l'abonnement. */
export function cliEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

// Sous Windows, la commande passe par le shell : on protège chaque argument.
const winQuote = (a) => `"${String(a).replace(/"/g, '\\"')}"`;
export function spawnClaude(args, opts = {}) {
  return spawn(IS_WIN ? winQuote(claudeBin()) : claudeBin(), IS_WIN ? args.map(winQuote) : args, {
    shell: IS_WIN, env: cliEnv(), stdio: ["pipe", "pipe", "pipe"], ...opts,
  });
}
function runSync(args, timeout = 20000) {
  return spawnSync(IS_WIN ? winQuote(claudeBin()) : claudeBin(), IS_WIN ? args.map(winQuote) : args, {
    shell: IS_WIN, env: cliEnv(), encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"],
  });
}

export function claudeCliVersion() {
  try {
    const r = runSync(["--version"], 15000);
    const m = r.status === 0 && r.stdout.match(/\d+\.\d+\.?\d*/);
    return m ? m[0] : null;
  } catch { return null; }
}

// ---------- état de connexion ----------
let cache = null, cacheAt = 0;
export function accountStatus(force = false) {
  if (!force && cache && Date.now() - cacheAt < 20000) return cache;
  let s = { installed: false, loggedIn: false };
  try {
    const r = runSync(["auth", "status", "--json"]);
    if (r.error) throw r.error;
    s.installed = true;
    const j = JSON.parse(r.stdout || "{}");
    s.loggedIn = !!j.loggedIn;
    s.method = j.authMethod || null;
    s.email = j.email || j.account?.email || null;
    s.subscription = j.subscriptionType || j.account?.subscriptionType || null;
  } catch {}
  cache = s; cacheAt = Date.now();
  return s;
}

// ---------- connexion pilotée depuis l'interface ----------
let login = { state: "idle" }; // idle | waiting | checking | done | error
let child = null;

export function loginState() {
  const { state, url, error } = login;
  return { state, url: url || null, error: error || null };
}

export function startLogin() {
  if (child) return loginState();
  login = { state: "starting" };
  let out = "";
  child = spawnClaude(["auth", "login", "--claudeai"]);
  const onData = (d) => {
    out += d;
    const m = out.match(/https:\/\/\S+\/oauth\/authorize\S+/);
    if (m && login.state === "starting") login = { state: "waiting", url: m[0] };
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => { login = { state: "error", error: `Impossible de lancer Claude Code : ${e.message}` }; child = null; });
  child.on("close", (code) => {
    child = null;
    const st = accountStatus(true);
    if (code === 0 && st.loggedIn) login = { state: "done" };
    else {
      const msg = (out.match(/Login failed:?\s*([^\n]+)/i) || [])[1] || (out.trim().split("\n").pop() || "").slice(0, 200);
      login = { state: "error", error: msg || "La connexion n'a pas abouti." };
    }
  });
  // Abandon automatique au bout de 15 minutes.
  setTimeout(() => { if (child) { child.kill(); } }, 15 * 60e3).unref();
  return loginState();
}

export function submitCode(code) {
  const c = String(code || "").trim();
  if (!child || login.state !== "waiting") throw new Error("Aucune connexion en cours. Relance « Connecter mon compte ».");
  if (!c) throw new Error("Colle le code affiché après la connexion.");
  login = { ...login, state: "checking" };
  child.stdin.write(c + "\n");
  return loginState();
}

export function cancelLogin() {
  if (child) child.kill();
  child = null;
  login = { state: "idle" };
  return loginState();
}

export function logout() {
  runSync(["auth", "logout"]);
  login = { state: "idle" };
  return accountStatus(true);
}
