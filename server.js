// Mora — serveur local. Lance avec `npm start`, puis ouvre http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(here, ".env"));
// Ancien nom de l'app : les réglages TAMIS_* d'un vieux .env marchent toujours.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("TAMIS_") && process.env["MORA_" + k.slice(6)] === undefined) process.env["MORA_" + k.slice(6)] = v;
}

const { Store, OUTSIDE, durationMin } = await import("./lib/store.js");
const { learn, score, LIKE_FACTOR, tossEffect, REASONS, sourceMatch, hasBlockedWord } = await import("./lib/learn.js");
const { translateTitles } = await import("./lib/translate.js");
const { discover, checkPage, hasCredentials, MODEL, LANGS } = await import("./lib/discover.js");
const { demoItems, DEMO_THEMES } = await import("./lib/demo.js");
const { discoverWithCli } = await import("./lib/discover-cli.js");
const { recordUsage, usageSummary } = await import("./lib/usage.js");
const account = await import("./lib/account.js");
const { als, current } = await import("./lib/context.js");
const { Auth } = await import("./lib/auth.js");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PAGE = 5;
const RAW = Symbol("brut"); // réponse non-JSON (export Markdown)
const HIDDEN_DAYS = 15; // les contenus masqués restent visibles 15 jours dans Réglages
const LOW_WATER = Number(process.env.MORA_MIN_PENDING || 8);        // relance une recherche sous ce seuil
const REFRESH_HOURS = Number(process.env.MORA_REFRESH_HOURS || 6);
const BATCH = Number(process.env.MORA_BATCH || 12);

// Moteur de recherche : abonnement Claude via Claude Code (par défaut), clé API, ou démo.
const CLI_VERSION = account.claudeCliVersion();
const BACKEND = (() => {
  const want = (process.env.MORA_BACKEND || "auto").toLowerCase();
  if (want === "demo") return "demo";
  if (want === "api") return "api";
  if (want === "claude-code") return "claude-code";
  if (CLI_VERSION) return "claude-code";
  if (hasCredentials()) return "api";
  return "demo";
})();
// Démo tant qu'aucun moteur n'est prêt (Claude Code présent mais compte pas encore connecté = démo aussi).
const aiReady = () => BACKEND === "api" || (BACKEND === "claude-code" && account.accountStatus().loggedIn);
const aiMode = () => BACKEND !== "demo";
const BACKEND_LABEL = BACKEND === "claude-code" ? `Claude Code (abonnement)` : BACKEND === "api" ? `API (${MODEL})` : "démo";

// ---------- comptes ----------
// Mode local (Mora écoute sur 127.0.0.1, ou MORA_AUTH=off) : un seul utilisateur, données dans le dossier de données.
// Sinon : chaque compte a son dossier users/<id> (mora.json + sa connexion Claude dans claude/).
const DATA_DIR = path.resolve(process.env.MORA_DATA_DIR || path.join(here, "data"));
const userDir = (id) => path.join(DATA_DIR, "users", id);
const auth = new Auth(DATA_DIR, process.env, HOST, adoptLegacyData);
const contexts = new Map(); // id du compte -> contexte
const U = () => current() || localCtx;
const S = () => U().store.state;
const tag = () => (U()?.label ? `[${U().label}] ` : "");
const log = (...a) => console.log(tag() + a.join(" "));
const logErr = (...a) => console.error(tag() + a.join(" "));
function makeCtx(dir, claudeDir, label) {
  const ctx = { dir, claudeDir, label, store: new Store(dir), refreshing: null, lastAttempt: 0, questing: null, translating: null, claude: {} };
  als.run(ctx, firstRun);
  return ctx;
}
const localCtx = auth.enabled ? null : makeCtx(DATA_DIR, null, null);
function userCtx(user) {
  let c = contexts.get(user.id);
  if (!c) { c = makeCtx(userDir(user.id), path.join(userDir(user.id), "claude"), user.username); contexts.set(user.id, c); }
  c.label = user.username;
  return c;
}
const forEachUser = (fn) => { if (localCtx) als.run(localCtx, fn); else for (const u of auth.users) als.run(userCtx(u), fn); };

// Le premier compte créé (administrateur) reprend les données d'avant les comptes (version 0.7 et avant).
function adoptLegacyData(user) {
  const dest = userDir(user.id);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ["mora.json", "tamis.json"]) {
    const src = path.join(DATA_DIR, f);
    if (fs.existsSync(src) && !fs.existsSync(path.join(dest, "mora.json"))) { fs.renameSync(src, path.join(dest, "mora.json")); console.log(`Données existantes confiées au compte « ${user.username} ».`); }
  }
  const oldClaude = process.env.CLAUDE_CONFIG_DIR && path.resolve(process.env.CLAUDE_CONFIG_DIR);
  if (oldClaude && oldClaude.startsWith(DATA_DIR + path.sep) && fs.existsSync(oldClaude) && !fs.existsSync(path.join(dest, "claude"))) {
    try { fs.renameSync(oldClaude, path.join(dest, "claude")); console.log(`Connexion Claude existante confiée au compte « ${user.username} ».`); } catch {}
  }
}

// Premier lancement d'un compte : thèmes d'exemple, et contenus d'exemple en mode démo.
function firstRun() {
  if (S().themes.length || S().items.length) return;
  S().themes = [...DEMO_THEMES];
  for (const t of DEMO_THEMES) S().weights.theme[t] = 1;
  if (!aiReady()) demoItems().forEach((i) => U().store.addItem(i));
  U().store.flush();
}

// ---------- recherche de contenus ----------
// u.lastAttempt évite d'enchaîner les recherches automatiques (elles comptent dans le quota du compte)
async function refresh(reason = "manuel") {
  const u = U();
  if (u.refreshing) return u.refreshing;
  if (!aiReady()) return null;
  u.lastAttempt = Date.now();
  return (u.refreshing = (async () => {
    log(`Recherche de nouveaux contenus (${reason})…`);
    try {
      const { items: found, suggestions, usage } = BACKEND === "claude-code" ? await discoverWithCli(S(), { count: BATCH }) : await discover(S(), { count: BATCH });
      const added = await addFound(found);
      addSuggestions(suggestions);
      recordUsage(S(), usage, { kind: "fil", label: reason, added, backend: BACKEND });
      log(`${added} nouvelles propositions ajoutées.`);
      S().lastRefresh = new Date().toISOString();
      S().lastError = null;
    } catch (e) {
      recordUsage(S(), e?.usage, { kind: "fil", label: `${reason} (échec)`, added: 0, backend: BACKEND });
      S().lastError = { at: new Date().toISOString(), message: String(e?.message || e) };
      logErr("Échec de la recherche :", e?.message || e);
    } finally {
      u.store.save();
      u.refreshing = null;
    }
  })());
}
// Filtre (doublons, mots-clés et sources interdits), vérifie les liens, puis ajoute. Renvoie le nombre ajouté.
async function addFound(found, extra = {}) {
  const P = S().prefs;
  const fresh = found.filter((raw) => {
    if (U().store.hasUrl(raw.url)) return false;
    if (hasBlockedWord(raw, P.blockedWords)) { log(`Écarté (mot-clé interdit) : ${raw.title}`); return false; }
    if (P.blockedSources.some((b) => sourceMatch(raw, b))) { log(`Écarté (source bloquée) : ${raw.source}`); return false; }
    return true;
  });
  // Vérification des liens, 6 à la fois.
  const checks = [];
  for (let k = 0; k < fresh.length; k += 6) checks.push(...(await Promise.all(fresh.slice(k, k + 6).map((r) => checkPage(r.url)))));
  // Si presque tout échoue, c'est sans doute la connexion de l'ordinateur, pas les liens : on garde tout.
  const failed = checks.filter((c) => !c.ok).length;
  const trust = failed < Math.max(2, fresh.length * 0.6);
  let added = 0;
  const batchAt = new Date().toISOString(); // même date pour toute la recherche : le fil les range ensemble
  fresh.forEach((raw, k) => {
    const c = checks[k];
    if (trust && !c.ok) { log(`Lien écarté (${c.reason}) : ${raw.url}`); return; }
    Object.assign(U().store.addItem({ ...raw, ...extra, image: c.image || null }), { foundAt: batchAt, batch: batchAt });
    added++;
  });
  return added;
}

// Thèmes suggérés par l'IA (sans doublon, sans ceux déjà refusés ou suivis).
function addSuggestions(list = []) {
  const known = (n) => [...S().themes, ...S().dismissedSuggestions, ...S().suggestions.map((x) => x.name)].some((t) => t.toLowerCase() === n.toLowerCase());
  for (const sg of list.slice(0, 2)) {
    const name = String(sg.name || "").trim().slice(0, 40);
    if (name && !known(name)) S().suggestions.push({ name, why: String(sg.why || "").slice(0, 160), at: new Date().toISOString() });
  }
}

// ---------- recherches ponctuelles ----------
async function runQuest(quest) {
  const u = U();
  u.questing = quest.id;
  log(`Recherche ponctuelle : ${quest.q}`);
  try {
    const opts = { count: 6, quest: { q: quest.q, label: quest.label } };
    const { items, usage } = BACKEND === "claude-code" ? await discoverWithCli(S(), opts) : await discover(S(), opts);
    quest.found = await addFound(items, { quest: quest.id });
    const e = recordUsage(S(), usage, { kind: "ponctuelle", label: quest.q, added: quest.found, backend: BACKEND });
    if (e) quest.tokens = e.tokens;
    quest.status = "done";
  } catch (e) {
    recordUsage(S(), e?.usage, { kind: "ponctuelle", label: `${quest.q} (échec)`, added: 0, backend: BACKEND });
    quest.status = "error"; quest.error = String(e?.message || e);
    logErr("Échec de la recherche ponctuelle :", quest.error);
  } finally {
    u.questing = null;
    u.store.save();
  }
}
const questView = (q) => ({ ...q, items: S().items.filter((i) => i.quest === q.id && ["quest", "keep", "shown"].includes(i.status)).map(pub) });

// ---------- export Markdown ----------
function keptMarkdown() {
  const kept = S().items.filter((i) => i.status === "keep").sort((a, b) => (b.decidedAt || "").localeCompare(a.decidedAt || ""));
  const byTheme = {};
  kept.forEach((i) => (byTheme[i.theme] ||= []).push(i));
  const TL = { article: "Article", video: "Vidéo", short: "Short", podcast: "Podcast", lien: "Lien" };
  const out = [`# Mes gardés Mora`, ``, `Exporté le ${new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })} · ${kept.length} contenu${kept.length > 1 ? "s" : ""}`, ``];
  for (const [theme, its] of Object.entries(byTheme)) {
    out.push(`## ${theme}`, ``);
    for (const i of its) {
      out.push(`### [${i.title.replace(/[[\]]/g, "")}](${i.url})${i.star ? " ★" : ""}`);
      out.push(`*${[TL[i.type] || "Lien", i.source, i.duration, i.decidedAt && "gardé le " + new Date(i.decidedAt).toLocaleDateString("fr-FR")].filter(Boolean).join(" · ")}*`, ``);
      if (i.titleOriginal) out.push(`Titre original : ${i.titleOriginal}`, ``);
      if (i.excerpt) out.push(i.excerpt, ``);
      if (i.note) out.push(`> **Ma note :** ${i.note.replace(/\n/g, "\n> ")}`, ``);
    }
  }
  return out.join("\n");
}

// ---------- traduction des anciens titres ----------
function translateOld() {
  const u = U();
  if (u.translating || !aiReady()) return;
  if (!S().items.some((i) => !i.titleFr && !i.demo && i.status !== "removed")) return;
  u.translating = (async () => {
    log("Traduction en français des titres déjà enregistrés…");
    try {
      const st = S();
      const n = await translateTitles(st.items, BACKEND, (usage) => recordUsage(st, usage, { kind: "traduction", label: "titres", backend: BACKEND }));
      log(`${n} titres traduits.`);
    } catch (e) {
      logErr("Échec de la traduction des titres :", e?.message || e);
    } finally {
      u.store.save();
      u.translating = null;
    }
  })();
}

const pending = () => S().items.filter((i) => i.status === "new").length;
function maybeRefresh(reason, force = false) {
  if (!aiReady() || U().refreshing) return;
  if (!force && Date.now() - U().lastAttempt < 30 * 60e3) return;
  const stale = !S().lastRefresh || Date.now() - Date.parse(S().lastRefresh) > REFRESH_HOURS * 3600e3;
  if (pending() < LOW_WATER || stale) refresh(reason);
}

// ---------- API ----------
const pub = (i) => ({ ...i });
function nextPage(n = PAGE, maxMin = 0) {
  const fits = (i) => !maxMin || (durationMin(i.duration) ?? Infinity) <= maxMin; // « J'ai X minutes »
  const fresh = S().items.filter((i) => i.status === "new" && fits(i)).sort((a, b) => score(S(), b) - score(S(), a)).slice(0, n);
  const now = new Date().toISOString();
  fresh.forEach((i) => { i.status = "shown"; i.shownAt = now; });
  U().store.save();
  maybeRefresh("réserve basse");
  return fresh;
}
// Déjà vu (signalé par le client lors d'une visite précédente) : quitte le fil au chargement suivant,
// sauf ce que tu as gardé ou aimé, qui reste toujours.
const stays = (i) => !i.seenAt || i.liked || i.status === "keep";
function streamView() {
  const since = Date.now() - 3 * 86400e3;
  return S().items
    .filter((i) => i.shownAt && stays(i) && Date.parse(i.shownAt) >= since && ["shown", "keep"].includes(i.status))
    .sort((a, b) => a.shownAt.localeCompare(b.shownAt));
}
const SEEN_DAYS = 7;
function seenView() {
  const since = Date.now() - SEEN_DAYS * 86400e3;
  return S().items
    .filter((i) => i.seenAt && Date.parse(i.seenAt) >= since && ["shown", "keep"].includes(i.status))
    .sort((a, b) => b.seenAt.localeCompare(a.seenAt));
}
function status() {
  return {
    mode: aiReady() ? "ia" : "demo", backend: BACKEND, needsLogin: BACKEND === "claude-code" && !account.accountStatus().loggedIn, model: BACKEND_LABEL, refreshing: !!U().refreshing, translating: !!U().translating, questing: !!U().questing, pending: pending(),
    lastRefresh: S().lastRefresh, lastError: S().lastError, decisions: S().decisions,
  };
}

const routes = [
  ["GET", /^\/api\/status$/, () => status()],
  ["GET", /^\/api\/stream$/, () => ({ items: streamView().map(pub), ...status() })],
  // Onglet « Déjà vu » : ce que tu as vu ces 7 derniers jours.
  ["GET", /^\/api\/seen$/, () => seenView().map(pub)],
  // Le client signale les posts vus (sortis par le haut de l'écran) : ils ne reviendront plus dans le fil.
  ["POST", /^\/api\/items\/seen$/, (m, body) => {
    const ids = new Set(Array.isArray(body.ids) ? body.ids.slice(0, 200).map(String) : []);
    const now = new Date().toISOString();
    let n = 0;
    for (const it of S().items) if (ids.has(it.id) && !it.seenAt) { it.seenAt = now; n++; }
    if (n) U().store.save();
    return { ok: true, marked: n };
  }],
  ["POST", /^\/api\/stream\/next$/, (m, body) => ({ items: nextPage(PAGE, Number(body.maxMin) || 0).map(pub), ...status() })],
  ["POST", /^\/api\/refresh$/, () => { if (!aiReady()) throw httpErr(400, "Connecte d’abord ton compte Claude dans l’onglet Réglages."); refresh("bouton"); return status(); }],

  ["POST", /^\/api\/items\/([\w-]+)\/decision$/, (m, body) => {
    const it = mustGet(m[1]);
    if (!["keep", "toss", "none"].includes(body.decision)) throw httpErr(400, "Décision inconnue.");
    decide(it, body.decision);
    return pub(it);
  }],
  // Remet un contenu masqué dans le fil (depuis Réglages › Masqués).
  ["POST", /^\/api\/items\/([\w-]+)\/restore$/, (m) => {
    const it = mustGet(m[1]);
    if (it.status !== "toss") return pub(it);
    decide(it, "none");
    it.shownAt = new Date().toISOString();
    U().store.save();
    return pub(it);
  }],
  ["GET", /^\/api\/hidden$/, () => {
    const since = Date.now() - HIDDEN_DAYS * 86400e3;
    return S().items.filter((i) => i.status === "toss" && Date.parse(i.decidedAt || 0) >= since)
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)).map(pub);
  }],

  // Raison facultative d'un masquage : remplace l'effet général par un effet ciblé.
  ["POST", /^\/api\/items\/([\w-]+)\/reason$/, (m, body) => {
    const it = mustGet(m[1]);
    if (it.status !== "toss") throw httpErr(400, "Ce contenu n’est pas masqué.");
    const r = body.reason === null ? null : String(body.reason);
    if (r !== null && !REASONS[r]) throw httpErr(400, "Raison inconnue.");
    tossEffect(S(), it, +1);  // annule l'effet actuel…
    it.reason = r;
    tossEffect(S(), it, -1);  // …et applique celui de la raison
    U().store.save();
    return pub(it);
  }],
  ["GET", /^\/api\/quests$/, () => S().quests.slice(-8).reverse().map(questView)],
  ["POST", /^\/api\/quests$/, (m, body) => {
    const q = String(body.q || "").trim().slice(0, 200);
    if (!q) throw httpErr(400, "Écris ce que tu cherches.");
    if (!aiReady()) throw httpErr(400, "Connecte d’abord ton compte Claude dans l’onglet Réglages.");
    if (U().questing) throw httpErr(409, "Une recherche ponctuelle est déjà en cours.");
    const label = q.replace(/^(trouve[- ]moi|cherche|des contenus sur|du contenu sur)\s+/i, "").replace(/\s+(cette semaine|ce mois-ci|aujourd’hui|aujourd'hui)$/i, "").slice(0, 40) || q.slice(0, 40);
    const quest = { id: crypto.randomUUID(), q, label: label[0].toUpperCase() + label.slice(1), at: new Date().toISOString(), status: "running", found: 0 };
    S().quests.push(quest);
    S().quests = S().quests.slice(-20);
    U().store.save();
    runQuest(quest);
    return questView(quest);
  }],
  ["DELETE", /^\/api\/quests\/([\w-]+)$/, (m) => {
    S().quests = S().quests.filter((q) => q.id !== m[1] || q.status === "running");
    S().items = S().items.filter((i) => !(i.quest === m[1] && i.status === "quest"));
    U().store.save();
    return { ok: true };
  }],

  ["POST", /^\/api\/suggestions\/(.+)\/(accept|dismiss)$/, (m) => {
    const name = decodeURIComponent(m[1]);
    S().suggestions = S().suggestions.filter((x) => x.name !== name);
    if (m[2] === "dismiss") S().dismissedSuggestions.push(name);
    else if (!S().themes.some((t) => t.toLowerCase() === name.toLowerCase())) {
      S().themes.push(name); S().weights.theme[name] = 1;
      if (aiReady()) refresh("thème suggéré");
    }
    U().store.save();
    return { themes: S().themes, weights: S().weights, suggestions: S().suggestions };
  }],

  ["GET", /^\/api\/kept\/export\.md$/, () => ({ [RAW]: true, type: "text/markdown; charset=utf-8", filename: `mora-gardes-${new Date().toISOString().slice(0, 10)}.md`, body: keptMarkdown() })],

  ["GET", /^\/api\/prefs$/, () => ({ prefs: S().prefs, langs: LANGS })],
  ["PATCH", /^\/api\/prefs$/, (m, body) => {
    const p = S().prefs;
    const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v))));
    if (typeof body.lang === "string" && LANGS[body.lang]) p.lang = body.lang;
    if (Number.isFinite(Number(body.nativeShare)) && body.nativeShare !== null) p.nativeShare = pct(body.nativeShare);
    if (Number.isFinite(Number(body.bubble)) && body.bubble !== null) p.bubble = Math.min(50, pct(body.bubble));
    if (body.mix && typeof body.mix === "object") {
      const mix = { ...p.mix };
      for (const k of ["article", "video", "short", "podcast"]) if (Number.isFinite(Number(body.mix[k]))) mix[k] = pct(body.mix[k]);
      if (Object.values(mix).some((v) => v > 0)) p.mix = mix; // au moins un format
    }
    for (const k of ["blockedWords", "blockedSources", "pinnedSources"])
      if (Array.isArray(body[k])) p[k] = [...new Set(body[k].map((x) => String(x).trim().slice(0, 60)).filter(Boolean))].slice(0, 50);
    if (typeof body.autoplay === "boolean") p.autoplay = body.autoplay;
    if (["auto", "light", "dark"].includes(body.mode)) p.mode = body.mode;
    if (typeof body.palette === "string" && /^[a-z-]{1,20}$/.test(body.palette)) p.palette = body.palette;
    U().store.save();
    return { prefs: p };
  }],

  ["GET", /^\/api\/stats$/, () => stats()],
  ["GET", /^\/api\/usage$/, () => ({ ...usageSummary(S()), backend: BACKEND, model: BACKEND_LABEL })],

  ["POST", /^\/api\/items\/([\w-]+)\/like$/, (m, body) => {
    const it = mustGet(m[1]);
    const want = !!body.liked;
    if (!!it.liked === want) return pub(it);
    it.liked = want;
    it.likedAt = want ? new Date().toISOString() : null;
    learn(S(), it, want ? +1 : -1, LIKE_FACTOR);
    if (want && it.status === "toss") { it.status = "shown"; tossEffect(S(), it, +1); it.reason = null; S().decisions = Math.max(0, S().decisions - 1); it.decidedAt = null; }
    U().store.save();
    return pub(it);
  }],

  ["GET", /^\/api\/account$/, () => ({ backend: BACKEND, version: CLI_VERSION, ...account.accountStatus(), login: account.loginState() })],
  ["POST", /^\/api\/account\/login$/, () => { if (BACKEND !== "claude-code") throw httpErr(400, "Claude Code n’est pas disponible."); return { login: account.startLogin() }; }],
  ["POST", /^\/api\/account\/code$/, (m, body) => { try { return { login: account.submitCode(body.code) }; } catch (e) { throw httpErr(400, e.message); } }],
  ["POST", /^\/api\/account\/cancel$/, () => ({ login: account.cancelLogin() })],
  ["POST", /^\/api\/account\/logout$/, () => ({ ...account.logout(), login: account.loginState() })],
  ["POST", /^\/api\/account\/connected$/, () => { const st = account.accountStatus(true); if (st.loggedIn) { removeUnseenDemo(); maybeRefresh("compte connecté", true); translateOld(); } return { ...st, ...status() }; }],

  ["GET", /^\/api\/kept$/, () => S().items.filter((i) => i.status === "keep").sort((a, b) => (b.decidedAt || "").localeCompare(a.decidedAt || "")).map(pub)],
  ["PATCH", /^\/api\/items\/([\w-]+)$/, (m, body) => {
    const it = mustGet(m[1]);
    if (typeof body.note === "string") it.note = body.note.slice(0, 2000);
    if (typeof body.star === "boolean") it.star = body.star;
    if (typeof body.theme === "string" && S().themes.includes(body.theme)) it.theme = body.theme;
    U().store.save();
    return pub(it);
  }],
  ["DELETE", /^\/api\/kept\/([\w-]+)$/, (m) => {
    const it = mustGet(m[1]);
    if (it.status === "keep") { it.status = "removed"; learn(S(), it, -1, 0.5); U().store.save(); }
    return { ok: true };
  }],

  ["GET", /^\/api\/themes$/, () => ({ themes: S().themes, weights: S().weights, decisions: S().decisions, suggestions: S().suggestions })],
  ["POST", /^\/api\/themes$/, (m, body) => {
    const name = String(body.name || "").trim().slice(0, 40);
    if (!name) throw httpErr(400, "Nom de thème vide.");
    if (!S().themes.some((t) => t.toLowerCase() === name.toLowerCase())) { S().themes.push(name); S().weights.theme[name] = 1; }
    U().store.save();
    if (aiReady()) refresh("nouveau thème");
    return { themes: S().themes, weights: S().weights };
  }],
  ["DELETE", /^\/api\/themes\/(.+)$/, (m) => {
    const name = decodeURIComponent(m[1]);
    S().themes = S().themes.filter((t) => t !== name);
    delete S().weights.theme[name];
    S().items = S().items.filter((i) => !(i.theme === name && i.status === "new"));
    U().store.save();
    return { themes: S().themes, weights: S().weights };
  }],
];

// Applique un choix (garder, masquer, ou annuler) et ajuste l'apprentissage.
function decide(it, want) {
  const prev = it.status === "keep" ? "keep" : it.status === "toss" ? "toss" : "none";
  if (prev === want) return;
  if (prev === "keep") learn(S(), it, -1);
  if (prev === "toss") { tossEffect(S(), it, +1); it.reason = null; }
  if (want === "keep") learn(S(), it, +1);
  if (want === "toss") tossEffect(S(), it, -1);
  if (want === "toss" && it.liked) { it.liked = false; it.likedAt = null; learn(S(), it, -1, LIKE_FACTOR); }
  if (prev === "none") S().decisions++;
  if (want === "none") S().decisions = Math.max(0, S().decisions - 1);
  it.status = want === "none" ? (it.quest && !it.shownAt ? "quest" : "shown") : want;
  it.decidedAt = want === "none" ? null : new Date().toISOString();
  U().store.save();
}

// Onglet Stats : centres d'intérêt, croisement thème × format, activité des 12 dernières semaines.
function stats() {
  const demoOk = !aiReady(); // en mode démo, les exemples comptent (sinon tout serait vide)
  const seen = S().items.filter((i) => i.shownAt && (demoOk || !i.demo));
  const pos = (i) => i.status === "keep" || i.liked;
  const themes = [...S().themes];
  if (seen.some((i) => i.theme === OUTSIDE) || (S().prefs.bubble ?? 0) > 0) themes.push(OUTSIDE);
  const perTheme = themes.map((t) => {
    const its = seen.filter((i) => i.theme === t);
    return { theme: t, weight: S().weights.theme[t] ?? 1, seen: its.length, liked: its.filter((i) => i.liked).length,
      kept: its.filter((i) => i.status === "keep").length, tossed: its.filter((i) => i.status === "toss").length };
  });
  const formats = ["article", "video", "short", "podcast", "lien"];
  const grid = themes.map((t) => formats.map((f) => {
    const its = seen.filter((i) => i.theme === t && i.type === f);
    return { pos: its.filter(pos).length, toss: its.filter((i) => i.status === "toss").length, seen: its.length };
  }));
  // Activité : une case par jour, nombre de j'aime + gardés + masqués.
  const days = {};
  const bump = (iso) => { if (iso) { const d = iso.slice(0, 10); days[d] = (days[d] || 0) + 1; } };
  for (const i of S().items) { if (i.demo && !demoOk) continue; bump(i.decidedAt); if (i.liked) bump(i.likedAt); }
  const lang = S().prefs.lang;
  const withLang = seen.filter((i) => i.language);
  return {
    themes: perTheme, formats, grid, days, weights: S().weights, outside: OUTSIDE,
    totals: { seen: seen.length, liked: seen.filter((i) => i.liked).length, kept: seen.filter((i) => i.status === "keep").length,
      tossed: seen.filter((i) => i.status === "toss").length, decisions: S().decisions },
    language: { lang, name: LANGS[lang], native: withLang.filter((i) => i.language.startsWith(lang)).length, known: withLang.length },
  };
}

// Quand le compte vient d'être connecté, on retire les exemples pas encore vus.
function removeUnseenDemo() {
  const before = S().items.length;
  S().items = S().items.filter((i) => !(i.demo && (i.status === "new" || i.status === "shown")));
  if (S().items.length !== before) U().store.save();
}

function httpErr(code, message) { const e = new Error(message); e.code = code; return e; }
function mustGet(id) { const it = U().store.get(id); if (!it) throw httpErr(404, "Contenu introuvable."); return it; }

// ---------- fichiers statiques ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const PUBLIC = path.join(here, "public");
function serveStatic(req, res, pathname) {
  let p; try { p = decodeURIComponent(pathname); } catch { return send(res, 400, { error: "Adresse invalide" }); }
  if (p === "/") p = "/index.html";
  if (p === "/login") p = "/login.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: "Interdit" });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: "Introuvable" });
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(buf);
  });
}
function send(res, code, data) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
const redirect = (res, to) => { res.writeHead(302, { location: to, "cache-control": "no-store" }); res.end(); };
async function readBody(req) {
  if (!["POST", "PATCH", "DELETE"].includes(req.method)) return {};
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) throw httpErr(413, "Requête trop grosse."); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw httpErr(400, "Requête illisible."); }
}
const reply = (res, out) => (out?.error ? send(res, out.code || 400, { error: out.error }) : send(res, 200, out));

// ---------- connexion et comptes ----------
async function authApi(req, res, pathname, body) {
  const s = auth.enabled ? auth.session(req) : null;
  const R = (method, re) => req.method === method && re.test(pathname);
  if (R("GET", /^\/api\/auth\/me$/)) return send(res, 200, auth.info(req));
  if (!auth.enabled) return send(res, 400, { error: "Les comptes sont désactivés (mode local)." });
  if (R("POST", /^\/api\/auth\/login$/)) return reply(res, auth.login(req, res, body));
  if (R("POST", /^\/api\/auth\/setup$/)) return reply(res, auth.setup(req, res, body));
  if (R("POST", /^\/api\/auth\/logout$/)) return reply(res, auth.logout(req, res, { everywhere: !!body.everywhere }));
  if (!s) return send(res, 401, { error: "Connecte-toi.", auth: true });
  if (R("POST", /^\/api\/auth\/password$/)) return reply(res, auth.changePassword(req, res, s, body));
  if (R("POST", /^\/api\/auth\/email$/)) return reply(res, auth.changeEmail(req, s, body));
  if (R("POST", /^\/api\/auth\/totp\/start$/)) return reply(res, await auth.totpStart(s));
  if (R("POST", /^\/api\/auth\/totp\/enable$/)) return reply(res, auth.totpEnable(req, s, body));
  if (R("POST", /^\/api\/auth\/totp\/disable$/)) return reply(res, auth.totpDisable(req, s, body));
  if (R("POST", /^\/api\/auth\/totp\/recovery$/)) return reply(res, auth.newRecovery(req, s, body));
  // Gestion des comptes : administrateurs seulement.
  if (!s.user.admin) return send(res, 403, { error: "Réservé aux administrateurs." });
  if (R("GET", /^\/api\/users$/)) return send(res, 200, auth.list().map((x) => {
    const u = auth.users.find((y) => y.id === x.id);
    const m = u ? usageSummary(userCtx(u).store.state).month : null; // consommation des 30 derniers jours, pour l'admin
    return m ? { ...x, usage30: { tokens: m.tokens, cost: m.cost, calls: m.calls } } : x;
  }));
  if (R("POST", /^\/api\/users$/)) return reply(res, auth.create(body));
  let m;
  if (req.method === "PATCH" && (m = pathname.match(/^\/api\/users\/([\w-]+)$/))) return reply(res, auth.update(s, m[1], body));
  if (req.method === "DELETE" && (m = pathname.match(/^\/api\/users\/([\w-]+)$/))) {
    const out = auth.remove(s, m[1]);
    if (out.error) return reply(res, out);
    // Supprime ses données (fil, gardés, connexion Claude) : un compte supprimé ne laisse rien.
    const c = contexts.get(m[1]);
    if (c) { c.claude.child?.kill(); clearTimeout(c.store.timer); contexts.delete(m[1]); }
    try { fs.rmSync(userDir(m[1]), { recursive: true, force: true }); } catch (e) { console.error("Suppression des données impossible :", e.message); }
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "Route inconnue" });
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    const { pathname } = new URL(req.url, "http://x");
    if (pathname === "/api/health") return send(res, 200, { ok: true });
    const s = auth.enabled ? auth.session(req) : null;

    if (!pathname.startsWith("/api/")) {
      // Pages : sans session, on montre l'écran de connexion.
      const page = pathname === "/" || pathname === "/index.html";
      if (auth.enabled && !s && page) return redirect(res, "/login");
      if (pathname === "/login" || pathname === "/login.html") { if (!auth.enabled || s) return redirect(res, "/"); }
      return serveStatic(req, res, pathname);
    }
    // Rien ne se modifie depuis un autre site (protection CSRF), y compris en mode local.
    if (!auth.sameOrigin(req)) return send(res, 403, { error: "Requête refusée (origine inconnue)." });
    const body = await readBody(req);
    if (pathname.startsWith("/api/auth/") || pathname === "/api/users" || pathname.startsWith("/api/users/")) return await authApi(req, res, pathname, body);
    if (auth.enabled && !s) return send(res, 401, { error: "Connecte-toi.", auth: true });

    const route = routes.find(([method, re]) => method === req.method && re.test(pathname));
    if (!route) return send(res, 404, { error: "Route inconnue" });
    // Chaque requête tourne dans le contexte de son compte (ses données, sa connexion Claude).
    const out = await als.run(s ? userCtx(s.user) : localCtx, () => route[2](pathname.match(route[1]), body));
    if (out?.[RAW]) {
      res.writeHead(200, { "content-type": out.type, "cache-control": "no-store", "content-disposition": `attachment; filename="${out.filename}"` });
      return res.end(out.body);
    }
    send(res, 200, out);
  } catch (e) {
    if (!res.headersSent) send(res, typeof e.code === "number" ? e.code : 500, { error: e.message || "Erreur" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\nMora tourne sur http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (auth.enabled) {
    console.log(`Comptes activés : ${auth.users.length} compte${auth.users.length > 1 ? "s" : ""}.`);
    if (auth.needsSetup) console.log(`\n  Premier lancement : ouvre Mora et crée le compte administrateur.\n  Code d’installation : ${auth.setupCode}\n`);
  } else console.log("Mode local : un seul utilisateur, sans mot de passe (Mora n’écoute que sur cet ordinateur).");
  if (BACKEND === "claude-code") console.log(`Claude Code ${CLI_VERSION} trouvé. Chaque compte connecte son abonnement Claude dans Réglages.`);
  else console.log(aiMode() ? `Recherche via ${BACKEND_LABEL}.` : "Mode démo : contenus d'exemple. Installe Claude Code (commande `claude`) et connecte-le à ton abonnement pour de vraies propositions.");
  console.log(`Recherche de contenus toutes les ${REFRESH_HOURS} h, ou quand il en reste moins de ${LOW_WATER}.`);
  forEachUser(() => { maybeRefresh("démarrage"); translateOld(); });
  setInterval(() => forEachUser(() => maybeRefresh("planifié")), 15 * 60e3).unref();
});

const flushAll = () => { localCtx?.store.flush(); for (const c of contexts.values()) c.store.flush(); };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { flushAll(); process.exit(0); });

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
