// Comptes Mora : adresse mail + mot de passe (+ application d'authentification en option), sessions par cookie,
// un administrateur qui gère les comptes. Mots de passe hachés avec scrypt, jetons de session aléatoires stockés hachés,
// double authentification TOTP (RFC 6238, compatible Google Authenticator, Aegis, 1Password…), anti-bruteforce.
// Données dans <dossier de données>/users.json (jamais dans le repo).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const COOKIE = "mora_session";
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;
const MIN_PASSWORD = 10;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

const b64 = (buf) => buf.toString("base64url");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(String(password).normalize("NFKC"), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64(salt)}$${b64(key)}`;
}
function checkPassword(password, stored) {
  const [kind, N, r, p, salt, key] = String(stored || "").split("$");
  if (kind !== "scrypt" || !key) return false;
  const want = Buffer.from(key, "base64url");
  const got = crypto.scryptSync(String(password).normalize("NFKC"), Buffer.from(salt, "base64url"), want.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return safeEq(got, want);
}
// Hachage factice : un identifiant inconnu prend autant de temps qu'un vrai (on ne devine pas qui existe).
const DUMMY = hashPassword(crypto.randomBytes(16));

export function validatePassword(pw) {
  pw = String(pw || "");
  if (pw.length < MIN_PASSWORD) return `Le mot de passe doit faire au moins ${MIN_PASSWORD} caractères.`;
  if (pw.length > 256) return "Le mot de passe est trop long (256 caractères maximum).";
  return null;
}
// Identifiant : une adresse mail (les comptes créés avant gardent leur ancien identifiant).
const isEmail = (u) => u.length <= 254 && /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>.]{2,}$/.test(u);
const normLogin = (u) => String(u || "").trim().toLowerCase();
function validateEmail(u) {
  return isEmail(normLogin(u)) ? null : "Indique une adresse mail valide.";
}
function validateLogin(u) { // adresse mail, ou ancien identifiant simple
  u = normLogin(u);
  return isEmail(u) || /^[\p{L}\p{N}._-]{2,32}$/u.test(u) ? null : "Indique une adresse mail valide.";
}

// ---------- double authentification (TOTP) ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32encode(buf) {
  let bits = 0, val = 0, out = "";
  for (const byte of buf) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  let bits = 0, val = 0; const out = [];
  for (const c of String(str).replace(/[\s=]/g, "").toUpperCase()) {
    const i = B32.indexOf(c); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", b32decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}
/** Le pas de temps (30 s) du code s'il est valide (±1 pas pour les horloges décalées), sinon null. */
function totpStep(secret, code, now = Date.now()) {
  code = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const t = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) if (safeEq(Buffer.from(hotp(secret, t + d)), Buffer.from(code))) return t + d;
  return null;
}
const newRecoveryCodes = () => Array.from({ length: 10 }, () => { const h = crypto.randomBytes(5).toString("hex"); return `${h.slice(0, 5)}-${h.slice(5)}`; });
const normRecovery = (c) => String(c || "").trim().toLowerCase().replace(/[^a-f0-9]/g, "");

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return out;
}
const err = (code, error) => ({ code, error });
const publicUser = (u) => ({ id: u.id, username: u.username, admin: !!u.admin, createdAt: u.createdAt, totp: !!u.totp });

export class Auth {
  /**
   * @param {string} dir dossier de données
   * @param {object} env process.env
   * @param {string} host adresse d'écoute du serveur
   * @param {(user) => void} onFirstAdmin appelé quand le premier compte (admin) est créé, pour lui donner les données existantes
   */
  constructor(dir, env, host, onFirstAdmin = () => {}) {
    const mode = String(env.MORA_AUTH || "auto").toLowerCase();
    this.enabled = ["on", "true", "1"].includes(mode) || (mode === "auto" && !LOOPBACK.has(host));
    this.sessionDays = Math.max(1, Number(env.MORA_SESSION_DAYS || 30));
    this.cookieSecure = String(env.MORA_COOKIE_SECURE || "auto").toLowerCase();
    this.file = path.join(dir, "users.json");
    this.onFirstAdmin = onFirstAdmin;
    this.data = this.#load();
    this.attempts = new Map(); // ip -> { fails, until }
    this.globalFails = [];
    this.setupCode = null;
    if (!this.enabled) return;

    // Premier compte fixé par l'environnement (template Unraid, compose) : créé une seule fois.
    if (!this.data.users.length && env.MORA_ADMIN_PASSWORD) {
      const username = normLogin(env.MORA_ADMIN_USER || "admin");
      const e = validateLogin(username) || validatePassword(env.MORA_ADMIN_PASSWORD);
      if (e) throw new Error(`Compte admin de MORA_ADMIN_USER / MORA_ADMIN_PASSWORD refusé : ${e}`);
      this.#addUser(username, env.MORA_ADMIN_PASSWORD, true);
      console.log(`Compte administrateur « ${username} » créé depuis la configuration.`);
    }
    // Sinon : création au premier passage, protégée par un code affiché dans les logs.
    if (!this.data.users.length) this.setupCode = crypto.randomBytes(4).toString("hex").toUpperCase();
    this.#prune();
  }

  #load() {
    try { const d = JSON.parse(fs.readFileSync(this.file, "utf8")); return { users: d.users || [], sessions: d.sessions || [] }; }
    catch { return { users: [], sessions: [] }; }
  }
  #save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  #prune() {
    const now = Date.now(), ids = new Set(this.data.users.map((u) => u.id)), before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.expires > now && ids.has(s.userId));
    if (this.data.sessions.length !== before) this.#save();
  }
  #byName(name) { const n = normLogin(name); return this.data.users.find((u) => u.username.toLowerCase() === n); }
  #addUser(username, password, admin) {
    const first = !this.data.users.length;
    const user = { id: crypto.randomUUID(), username: normLogin(username), hash: hashPassword(password), admin: !!admin, createdAt: new Date().toISOString() };
    this.data.users.push(user);
    this.#save();
    if (first) this.onFirstAdmin(user);
    return user;
  }

  get needsSetup() { return this.enabled && !this.data.users.length; }
  get users() { return this.data.users; }

  // ---------- requêtes ----------
  // Adresse du client. Derrière un reverse proxy du réseau local (Nginx Proxy Manager…), on prend la dernière
  // adresse ajoutée à X-Forwarded-For par ce proxy : les précédentes viennent du client et peuvent être inventées.
  clientIp(req) {
    const remote = String(req.socket.remoteAddress || "?").replace(/^::ffff:/, "");
    const local = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80)/i.test(remote);
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
    return local && xff.length ? xff[xff.length - 1] : remote;
  }
  isHttps(req) {
    if (["on", "true", "1"].includes(this.cookieSecure)) return true;
    if (["off", "false", "0"].includes(this.cookieSecure)) return false;
    return !!req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  }

  /** Le compte connecté de la requête ({ user, sid }), ou null. La session est glissante. */
  session(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token || token.length > 100) return null;
    const sid = sha256(token), now = Date.now();
    const s = this.data.sessions.find((x) => x.id === sid);
    if (!s || s.expires <= now) return null;
    const user = this.data.users.find((u) => u.id === s.userId);
    if (!user) return null;
    if (now - (s.seenAt || 0) > 60 * 60e3) { s.seenAt = now; s.expires = now + this.sessionDays * 864e5; this.#save(); } // au plus une écriture par heure
    return { user, sid };
  }

  /** Bloque les requêtes qui modifient quelque chose depuis un autre site (CSRF). */
  sameOrigin(req) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
    const origin = req.headers.origin || req.headers.referer;
    if (!origin) return false;
    let o; try { o = new URL(origin).host; } catch { return false; }
    const hosts = [req.headers.host, req.headers["x-forwarded-host"]].filter(Boolean).flatMap((h) => String(h).split(",").map((x) => x.trim()));
    return hosts.includes(o);
  }

  // ---------- anti-bruteforce ----------
  #blocked(ip) {
    const now = Date.now();
    this.globalFails = this.globalFails.filter((t) => now - t < 15 * 60e3);
    if (this.globalFails.length >= 50) return Math.ceil((this.globalFails[0] + 15 * 60e3 - now) / 60e3);
    const a = this.attempts.get(ip);
    return a && a.until > now ? Math.ceil((a.until - now) / 60e3) : 0;
  }
  #fail(ip) {
    const now = Date.now();
    this.globalFails.push(now);
    const a = this.attempts.get(ip) || { fails: 0, until: 0 };
    a.fails++;
    if (a.fails >= 5) a.until = now + Math.min(60, 2 ** (a.fails - 5)) * 60e3; // 5 essais, puis 1 min, 2, 4… jusqu'à 1 h
    this.attempts.set(ip, a);
    if (this.attempts.size > 5000) this.attempts.delete(this.attempts.keys().next().value);
  }
  #guard(req) {
    const wait = this.#blocked(this.clientIp(req));
    return wait ? err(429, `Trop d’essais. Réessaie dans ${wait} min.`) : null;
  }

  #newSession(req, res, user) {
    const token = b64(crypto.randomBytes(32)), now = Date.now();
    this.#prune();
    this.data.sessions.push({ id: sha256(token), userId: user.id, createdAt: now, seenAt: now, expires: now + this.sessionDays * 864e5,
      agent: String(req.headers["user-agent"] || "").slice(0, 160) });
    // au plus 20 sessions par compte
    const mine = this.data.sessions.filter((s) => s.userId === user.id);
    if (mine.length > 20) { const drop = new Set(mine.slice(0, mine.length - 20).map((s) => s.id)); this.data.sessions = this.data.sessions.filter((s) => !drop.has(s.id)); }
    this.#save();
    this.#setCookie(req, res, token, this.sessionDays * 86400);
  }
  #setCookie(req, res, value, maxAge) {
    const parts = [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
    if (this.isHttps(req)) parts.push("Secure");
    res.setHeader("set-cookie", parts.join("; "));
  }

  // ---------- connexion ----------
  info(req) {
    if (!this.enabled) return { enabled: false };
    const s = this.session(req);
    return { enabled: true, needsSetup: this.needsSetup, loggedIn: !!s, user: s ? publicUser(s.user) : null,
      sessions: s ? this.data.sessions.filter((x) => x.userId === s.user.id).length : undefined,
      recoveryLeft: s?.user.totp ? (s.user.recovery || []).length : undefined };
  }

  login(req, res, { username, password, code }) {
    const blocked = this.#guard(req); if (blocked) return blocked;
    const ip = this.clientIp(req);
    const user = this.#byName(username);
    const ok = checkPassword(String(password || ""), user ? user.hash : DUMMY);
    if (!user || !ok) {
      this.#fail(ip);
      console.log(`Connexion refusée depuis ${ip}.`);
      return err(401, "Adresse mail ou mot de passe incorrect.");
    }
    // Double authentification : le mot de passe est bon, il faut encore le code de l'application.
    if (user.totp) {
      if (!code) return { totp: true };
      if (!this.#checkSecondFactor(user, code)) { this.#fail(ip); console.log(`Code de double authentification refusé depuis ${ip}.`); return err(401, "Code incorrect ou expiré."); }
    }
    this.attempts.delete(ip);
    this.#newSession(req, res, user);
    return { ok: true };
  }

  /** Code de l'application (une seule utilisation par code) ou code de secours (à usage unique). */
  #checkSecondFactor(user, code) {
    const step = totpStep(user.totp, code);
    if (step !== null && step > (user.totpLast || 0)) { user.totpLast = step; this.#save(); return true; }
    const r = normRecovery(code);
    if (r.length === 10) {
      const h = sha256(r), i = (user.recovery || []).indexOf(h);
      if (i >= 0) { user.recovery.splice(i, 1); this.#save(); console.log(`Code de secours utilisé par « ${user.username} » (${user.recovery.length} restants).`); return true; }
    }
    return false;
  }

  // ---------- double authentification : activation depuis Réglages ----------
  async totpStart(s) {
    // chargé seulement ici : une ancienne installation sans `npm install` récent démarre quand même
    const { default: qrcode } = await import("qrcode-generator");
    const secret = b32encode(crypto.randomBytes(20));
    s.user.totpPending = secret; this.#save();
    const label = encodeURIComponent(`Mora:${s.user.username}`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=Mora&algorithm=SHA1&digits=6&period=30`;
    const qr = qrcode(0, "M"); qr.addData(uri); qr.make();
    return { secret: secret.match(/.{1,4}/g).join(" "), uri, svg: qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true }) };
  }
  totpEnable(req, s, { code }) {
    const blocked = this.#guard(req); if (blocked) return blocked;
    const secret = s.user.totpPending;
    if (!secret) return err(400, "Recommence l’activation.");
    const step = totpStep(secret, code);
    if (step === null) { this.#fail(this.clientIp(req)); return err(400, "Code incorrect. Vérifie l’heure de ton téléphone et réessaie avec le code affiché."); }
    const codes = newRecoveryCodes();
    Object.assign(s.user, { totp: secret, totpLast: step, recovery: codes.map((c) => sha256(normRecovery(c))) });
    delete s.user.totpPending;
    this.data.sessions = this.data.sessions.filter((x) => x.userId !== s.user.id || x.id === s.sid); // autres appareils déconnectés
    this.#save();
    console.log(`Double authentification activée pour « ${s.user.username} ».`);
    return { ok: true, recovery: codes };
  }
  totpDisable(req, s, { password }) {
    const blocked = this.#guard(req); if (blocked) return blocked;
    if (!checkPassword(String(password || ""), s.user.hash)) { this.#fail(this.clientIp(req)); return err(401, "Mot de passe incorrect."); }
    for (const k of ["totp", "totpLast", "recovery", "totpPending"]) delete s.user[k];
    this.#save();
    console.log(`Double authentification désactivée pour « ${s.user.username} ».`);
    return { ok: true };
  }
  newRecovery(req, s, { password }) {
    const blocked = this.#guard(req); if (blocked) return blocked;
    if (!s.user.totp) return err(400, "La double authentification n’est pas activée.");
    if (!checkPassword(String(password || ""), s.user.hash)) { this.#fail(this.clientIp(req)); return err(401, "Mot de passe incorrect."); }
    const codes = newRecoveryCodes();
    s.user.recovery = codes.map((c) => sha256(normRecovery(c)));
    this.#save();
    return { ok: true, recovery: codes };
  }
  /** Change sa propre adresse mail de connexion. */
  changeEmail(req, s, { current, email }) {
    const blocked = this.#guard(req); if (blocked) return blocked;
    if (!checkPassword(String(current || ""), s.user.hash)) { this.#fail(this.clientIp(req)); return err(401, "Mot de passe incorrect."); }
    const e = validateEmail(email); if (e) return err(400, e);
    const other = this.#byName(email);
    if (other && other.id !== s.user.id) return err(409, "Cette adresse mail est déjà utilisée.");
    s.user.username = normLogin(email); this.#save();
    return publicUser(s.user);
  }

  setup(req, res, { username, password, code }) {
    if (!this.needsSetup) return err(409, "Le compte administrateur existe déjà.");
    const blocked = this.#guard(req); if (blocked) return blocked;
    const got = Buffer.from(String(code || "").trim().toUpperCase()), want = Buffer.from(this.setupCode);
    if (!safeEq(got, want)) { this.#fail(this.clientIp(req)); return err(401, "Code d’installation incorrect (il est affiché dans les logs de Mora)."); }
    const e = validateEmail(username) || validatePassword(password);
    if (e) return err(400, e);
    const user = this.#addUser(username, password, true);
    this.setupCode = null;
    console.log(`Compte administrateur « ${user.username} » créé.`);
    this.#newSession(req, res, user);
    return { ok: true };
  }

  logout(req, res, { everywhere = false } = {}) {
    const s = this.session(req);
    if (s) {
      this.data.sessions = this.data.sessions.filter((x) => everywhere ? x.userId !== s.user.id : x.id !== s.sid);
      this.#save();
    }
    this.#setCookie(req, res, "", 0);
    return { ok: true };
  }

  changePassword(req, res, s, { current, password }) {
    const blocked = this.#guard(req); if (blocked) return blocked;
    if (!checkPassword(String(current || ""), s.user.hash)) { this.#fail(this.clientIp(req)); return err(401, "Mot de passe actuel incorrect."); }
    const e = validatePassword(password);
    if (e) return err(400, e);
    s.user.hash = hashPassword(password);
    this.data.sessions = this.data.sessions.filter((x) => x.userId !== s.user.id); // déconnecte partout…
    this.#newSession(req, res, s.user); // …sauf cet appareil
    return { ok: true };
  }

  // ---------- gestion des comptes (admin) ----------
  list() { return this.data.users.map(publicUser); }

  create({ username, password, admin }) {
    const e = validateEmail(username) || validatePassword(password);
    if (e) return err(400, e);
    if (this.#byName(username)) return err(409, "Cette adresse mail a déjà un compte.");
    const user = this.#addUser(username, password, admin);
    console.log(`Compte « ${user.username} » créé.`);
    return publicUser(user);
  }

  update(s, id, { password, admin, username, totp }) {
    const user = this.data.users.find((u) => u.id === id);
    if (!user) return err(404, "Compte introuvable.");
    if (username !== undefined) {
      const e = validateEmail(username); if (e) return err(400, e);
      const other = this.#byName(username);
      if (other && other.id !== user.id) return err(409, "Cette adresse mail a déjà un compte.");
      user.username = normLogin(username);
    }
    // Téléphone perdu : l'administrateur retire la double authentification, la personne la réactive ensuite.
    if (totp === false) { for (const k of ["totp", "totpLast", "recovery", "totpPending"]) delete user[k]; console.log(`Double authentification retirée pour « ${user.username} ».`); }
    if (typeof admin === "boolean" && admin !== user.admin) {
      if (!admin && this.data.users.filter((u) => u.admin).length <= 1) return err(400, "Il faut garder au moins un administrateur.");
      user.admin = admin;
    }
    if (password !== undefined) {
      const e = validatePassword(password);
      if (e) return err(400, e);
      user.hash = hashPassword(password);
      this.data.sessions = this.data.sessions.filter((x) => x.userId !== user.id || x.id === s.sid);
    }
    this.#save();
    return publicUser(user);
  }

  remove(s, id) {
    const user = this.data.users.find((u) => u.id === id);
    if (!user) return err(404, "Compte introuvable.");
    if (user.id === s.user.id) return err(400, "Tu ne peux pas supprimer ton propre compte.");
    this.data.users = this.data.users.filter((u) => u.id !== id);
    this.data.sessions = this.data.sessions.filter((x) => x.userId !== id);
    this.#save();
    console.log(`Compte « ${user.username} » supprimé.`);
    return { ok: true, user };
  }
}
