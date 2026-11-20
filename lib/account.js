// Connexion du compte Claude (abonnement) depuis l'interface.
// Mora embarque Claude Code (dépendance npm) et pilote sa connexion : `claude auth login`.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { current } from "./context.js";

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
  // Multi-comptes : chaque compte Mora a sa propre connexion Claude, dans son propre dossier.
  const dir = current()?.claudeDir;
  // Un jeton global partagerait le même abonnement entre tous les comptes : on l'écarte.
  if (dir) { fs.mkdirSync(dir, { recursive: true }); env.CLAUDE_CONFIG_DIR = dir; delete env.CLAUDE_CODE_OAUTH_TOKEN; }
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

// ---------- état de connexion (un par compte Mora) ----------
const localSlot = {};
const slot = () => { const c = current(); return c ? (c.claude ||= {}) : localSlot; };

export function accountStatus(force = false) {
  const z = slot();
  if (!force && z.cache && Date.now() - z.cacheAt < 20000) return z.cache;
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
  z.cache = s; z.cacheAt = Date.now();
  return s;
}

// ---------- connexion pilotée depuis l'interface ----------
// z.login : idle | waiting | checking | done | error ; z.child : le processus `claude auth login` en cours
export function loginState() {
  const { state, url, error } = slot().login || { state: "idle" };
  return { state, url: url || null, error: error || null };
}

export function startLogin() {
  const z = slot();
  if (z.child) return loginState();
  z.login = { state: "starting" };
  let out = "";
  const child = z.child = spawnClaude(["auth", "login", "--claudeai"]);
  const onData = (d) => {
    out += d;
    const m = out.match(/https:\/\/\S+\/oauth\/authorize\S+/);
    if (m && z.login.state === "starting") z.login = { state: "waiting", url: m[0] };
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => { z.login = { state: "error", error: `Impossible de lancer Claude Code : ${e.message}` }; z.child = null; });
  child.on("close", (code) => {
    if (z.child === child) z.child = null;
    const st = accountStatus(true);
    if (code === 0 && st.loggedIn) z.login = { state: "done" };
    else if (z.login.state !== "idle") {
      const msg = (out.match(/Login failed:?\s*([^\n]+)/i) || [])[1] || (out.trim().split("\n").pop() || "").slice(0, 200);
      z.login = { state: "error", error: msg || "La connexion n'a pas abouti." };
    }
  });
  // Abandon automatique au bout de 15 minutes.
  setTimeout(() => { if (z.child === child) child.kill(); }, 15 * 60e3).unref();
  return loginState();
}

export function submitCode(code) {
  const z = slot();
  const c = String(code || "").trim();
  if (!z.child || z.login?.state !== "waiting") throw new Error("Aucune connexion en cours. Relance « Connecter mon compte ».");
  if (!c) throw new Error("Colle le code affiché après la connexion.");
  z.login = { ...z.login, state: "checking" };
  z.child.stdin.write(c + "\n");
  return loginState();
}

export function cancelLogin() {
  const z = slot();
  z.login = { state: "idle" };
  if (z.child) z.child.kill();
  z.child = null;
  return loginState();
}

export function logout() {
  runSync(["auth", "logout"]);
  slot().login = { state: "idle" };
  return accountStatus(true);
}
