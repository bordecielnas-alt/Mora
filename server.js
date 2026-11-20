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
const account = await import("./lib/account.js");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PAGE = 5;
const RAW = Symbol("brut"); // réponse non-JSON (export Markdown)
const HIDDEN_DAYS = 15; // les contenus masqués restent visibles 15 jours dans Réglages
const LOW_WATER = Number(process.env.MORA_MIN_PENDING || 8);        // relance une recherche sous ce seuil
const REFRESH_HOURS = Number(process.env.MORA_REFRESH_HOURS || 6);
const BATCH = Number(process.env.MORA_BATCH || 12);

const store = new Store(process.env.MORA_DATA_DIR || path.join(here, "data"));
const S = () => store.state;
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

// Premier lancement : thèmes d'exemple, et contenus d'exemple en mode démo.
if (!S().themes.length && !S().items.length) {
  S().themes = [...DEMO_THEMES];
  for (const t of DEMO_THEMES) S().weights.theme[t] = 1;
  if (!aiReady()) demoItems().forEach((i) => store.addItem(i));
  store.flush();
}

// ---------- recherche de contenus ----------
let refreshing = null;
let lastAttempt = 0; // évite d'enchaîner les recherches automatiques (elles comptent dans ton quota)
async function refresh(reason = "manuel") {
  if (refreshing) return refreshing;
  if (!aiReady()) return null;
  lastAttempt = Date.now();
  refreshing = (async () => {
    console.log(`Recherche de nouveaux contenus (${reason})…`);
    try {
      const { items: found, suggestions } = BACKEND === "claude-code" ? await discoverWithCli(S(), { count: BATCH }) : await discover(S(), { count: BATCH });
      const added = await addFound(found);
      addSuggestions(suggestions);
      console.log(`${added} nouvelles propositions ajoutées.`);
      S().lastRefresh = new Date().toISOString();
      S().lastError = null;
    } catch (e) {
      S().lastError = { at: new Date().toISOString(), message: String(e?.message || e) };
      console.error("Échec de la recherche :", e?.message || e);
    } finally {
      store.save();
      refreshing = null;
    }
  })();
  return refreshing;
}
// Filtre (doublons, mots-clés et sources interdits), vérifie les liens, puis ajoute. Renvoie le nombre ajouté.
async function addFound(found, extra = {}) {
  const P = S().prefs;
  const fresh = found.filter((raw) => {
    if (store.hasUrl(raw.url)) return false;
    if (hasBlockedWord(raw, P.blockedWords)) { console.log(`Écarté (mot-clé interdit) : ${raw.title}`); return false; }
    if (P.blockedSources.some((b) => sourceMatch(raw, b))) { console.log(`Écarté (source bloquée) : ${raw.source}`); return false; }
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
    if (trust && !c.ok) { console.log(`Lien écarté (${c.reason}) : ${raw.url}`); return; }
    Object.assign(store.addItem({ ...raw, ...extra, image: c.image || null }), { foundAt: batchAt, batch: batchAt });
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
let questing = null;
async function runQuest(quest) {
  questing = quest.id;
  console.log(`Recherche ponctuelle : ${quest.q}`);
  try {
    const opts = { count: 6, quest: { q: quest.q, label: quest.label } };
    const { items } = BACKEND === "claude-code" ? await discoverWithCli(S(), opts) : await discover(S(), opts);
    quest.found = await addFound(items, { quest: quest.id });
    quest.status = "done";
  } catch (e) {
    quest.status = "error"; quest.error = String(e?.message || e);
    console.error("Échec de la recherche ponctuelle :", quest.error);
  } finally {
    questing = null;
    store.save();
  }
}
const questView = (q) => ({ ...q, items: S().items.filter((i) => i.quest === q.id && ["quest", "keep", "shown"].includes(i.status)).map(pub) });

// ---------- export Markdown ----------
function keptMarkdown() {
  const kept = S().items.filter((i) => i.status === "keep").sort((a, b) => (b.decidedAt || "").localeCompare(a.decidedAt || ""));
  const byTheme = {};
  kept.forEach((i) => (byTheme[i.theme] ||= []).push(i));
  const TL = { article: "Article", video: "Vidéo", podcast: "Podcast", lien: "Lien" };
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
let translating = null;
function translateOld() {
  if (translating || !aiReady()) return;
  if (!S().items.some((i) => !i.titleFr && !i.demo && i.status !== "removed")) return;
  translating = (async () => {
    console.log("Traduction en français des titres déjà enregistrés…");
    try {
      const n = await translateTitles(S().items, BACKEND);
      console.log(`${n} titres traduits.`);
    } catch (e) {
      console.error("Échec de la traduction des titres :", e?.message || e);
    } finally {
      store.save();
      translating = null;
    }
  })();
}

const pending = () => S().items.filter((i) => i.status === "new").length;
function maybeRefresh(reason, force = false) {
  if (!aiReady() || refreshing) return;
  if (!force && Date.now() - lastAttempt < 30 * 60e3) return;
  const stale = !S().lastRefresh || Date.now() - Date.parse(S().lastRefresh) > REFRESH_HOURS * 3600e3;
  if (pending() < LOW_WATER || stale) refresh(reason);
}

// ---------- API ----------
const pub = (i) => ({ ...i });
// Nouveautés en haut : la recherche la plus récente d'abord (à la minute près), puis le score dans chaque recherche.
const batchKey = (i) => i.batch || String(i.foundAt || "").slice(0, 16); // anciens contenus : regroupés à la minute
const newestFirst = (a, b) => batchKey(b).localeCompare(batchKey(a)) || score(S(), b) - score(S(), a);
function nextPage(n = PAGE, maxMin = 0) {
  const fits = (i) => !maxMin || (durationMin(i.duration) ?? Infinity) <= maxMin; // « J'ai X minutes »
  const fresh = S().items.filter((i) => i.status === "new" && fits(i)).sort(newestFirst).slice(0, n);
  const now = new Date().toISOString();
  fresh.forEach((i) => { i.status = "shown"; i.shownAt = now; });
  store.save();
  maybeRefresh("réserve basse");
  return fresh;
}
function streamView() {
  const since = Date.now() - 3 * 86400e3;
  return S().items
    .filter((i) => i.shownAt && Date.parse(i.shownAt) >= since && ["shown", "keep"].includes(i.status))
    .sort(newestFirst);
}
function status() {
  return {
    mode: aiReady() ? "ia" : "demo", backend: BACKEND, needsLogin: BACKEND === "claude-code" && !account.accountStatus().loggedIn, model: BACKEND_LABEL, refreshing: !!refreshing, translating: !!translating, questing: !!questing, pending: pending(),
    lastRefresh: S().lastRefresh, lastError: S().lastError, decisions: S().decisions,
  };
}

const routes = [
  ["GET", /^\/api\/status$/, () => status()],
  ["GET", /^\/api\/stream$/, () => ({ items: streamView().map(pub), ...status() })],
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
    store.save();
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
    store.save();
    return pub(it);
  }],
  ["GET", /^\/api\/quests$/, () => S().quests.slice(-8).reverse().map(questView)],
  ["POST", /^\/api\/quests$/, (m, body) => {
    const q = String(body.q || "").trim().slice(0, 200);
    if (!q) throw httpErr(400, "Écris ce que tu cherches.");
    if (!aiReady()) throw httpErr(400, "Connecte d’abord ton compte Claude dans l’onglet Réglages.");
    if (questing) throw httpErr(409, "Une recherche ponctuelle est déjà en cours.");
    const label = q.replace(/^(trouve[- ]moi|cherche|des contenus sur|du contenu sur)\s+/i, "").replace(/\s+(cette semaine|ce mois-ci|aujourd’hui|aujourd'hui)$/i, "").slice(0, 40) || q.slice(0, 40);
    const quest = { id: crypto.randomUUID(), q, label: label[0].toUpperCase() + label.slice(1), at: new Date().toISOString(), status: "running", found: 0 };
    S().quests.push(quest);
    S().quests = S().quests.slice(-20);
    store.save();
    runQuest(quest);
    return questView(quest);
  }],
  ["DELETE", /^\/api\/quests\/([\w-]+)$/, (m) => {
    S().quests = S().quests.filter((q) => q.id !== m[1] || q.status === "running");
    S().items = S().items.filter((i) => !(i.quest === m[1] && i.status === "quest"));
    store.save();
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
    store.save();
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
      for (const k of ["article", "video", "podcast"]) if (Number.isFinite(Number(body.mix[k]))) mix[k] = pct(body.mix[k]);
      if (Object.values(mix).some((v) => v > 0)) p.mix = mix; // au moins un format
    }
    for (const k of ["blockedWords", "blockedSources", "pinnedSources"])
      if (Array.isArray(body[k])) p[k] = [...new Set(body[k].map((x) => String(x).trim().slice(0, 60)).filter(Boolean))].slice(0, 50);
    if (typeof body.autoplay === "boolean") p.autoplay = body.autoplay;
    if (["auto", "light", "dark"].includes(body.mode)) p.mode = body.mode;
    if (typeof body.palette === "string" && /^[a-z-]{1,20}$/.test(body.palette)) p.palette = body.palette;
    store.save();
    return { prefs: p };
  }],

  ["GET", /^\/api\/stats$/, () => stats()],

  ["POST", /^\/api\/items\/([\w-]+)\/like$/, (m, body) => {
    const it = mustGet(m[1]);
    const want = !!body.liked;
    if (!!it.liked === want) return pub(it);
    it.liked = want;
    it.likedAt = want ? new Date().toISOString() : null;
    learn(S(), it, want ? +1 : -1, LIKE_FACTOR);
    if (want && it.status === "toss") { it.status = "shown"; tossEffect(S(), it, +1); it.reason = null; S().decisions = Math.max(0, S().decisions - 1); it.decidedAt = null; }
    store.save();
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
    store.save();
    return pub(it);
  }],
  ["DELETE", /^\/api\/kept\/([\w-]+)$/, (m) => {
    const it = mustGet(m[1]);
    if (it.status === "keep") { it.status = "removed"; learn(S(), it, -1, 0.5); store.save(); }
    return { ok: true };
  }],

  ["GET", /^\/api\/themes$/, () => ({ themes: S().themes, weights: S().weights, decisions: S().decisions, suggestions: S().suggestions })],
  ["POST", /^\/api\/themes$/, (m, body) => {
    const name = String(body.name || "").trim().slice(0, 40);
    if (!name) throw httpErr(400, "Nom de thème vide.");
    if (!S().themes.some((t) => t.toLowerCase() === name.toLowerCase())) { S().themes.push(name); S().weights.theme[name] = 1; }
    store.save();
    if (aiReady()) refresh("nouveau thème");
    return { themes: S().themes, weights: S().weights };
  }],
  ["DELETE", /^\/api\/themes\/(.+)$/, (m) => {
    const name = decodeURIComponent(m[1]);
    S().themes = S().themes.filter((t) => t !== name);
    delete S().weights.theme[name];
    S().items = S().items.filter((i) => !(i.theme === name && i.status === "new"));
    store.save();
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
  store.save();
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
  const formats = ["article", "video", "podcast", "lien"];
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
  if (S().items.length !== before) store.save();
}

function httpErr(code, message) { const e = new Error(message); e.code = code; return e; }
function mustGet(id) { const it = store.get(id); if (!it) throw httpErr(404, "Contenu introuvable."); return it; }

// ---------- fichiers statiques ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const PUBLIC = path.join(here, "public");
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
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

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  if (!pathname.startsWith("/api/")) return serveStatic(req, res);
  const route = routes.find(([method, re]) => method === req.method && re.test(pathname));
  if (!route) return send(res, 404, { error: "Route inconnue" });
  try {
    let body = {};
    if (["POST", "PATCH"].includes(req.method)) {
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) throw httpErr(413, "Requête trop grosse."); }
      body = raw ? JSON.parse(raw) : {};
    }
    const out = await route[2](pathname.match(route[1]), body);
    if (out?.[RAW]) {
      res.writeHead(200, { "content-type": out.type, "cache-control": "no-store", "content-disposition": `attachment; filename="${out.filename}"` });
      return res.end(out.body);
    }
    send(res, 200, out);
  } catch (e) {
    send(res, typeof e.code === "number" ? e.code : 500, { error: e.message || "Erreur" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\nMora tourne sur http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (BACKEND === "claude-code" && !account.accountStatus().loggedIn)
    console.log(`Claude Code ${CLI_VERSION} trouvé, compte pas encore connecté : ouvre l'app, onglet Réglages, « Connecter mon compte Claude ».`);
  else console.log(aiMode()
    ? `Recherche via ${BACKEND_LABEL}${CLI_VERSION && BACKEND === "claude-code" ? ` ${CLI_VERSION}` : ""} : recherche de contenus toutes les ${REFRESH_HOURS} h, ou quand il en reste moins de ${LOW_WATER}.`
    : "Mode démo : contenus d'exemple. Installe Claude Code (commande `claude`) et connecte-le à ton abonnement pour de vraies propositions.");
  maybeRefresh("démarrage");
  translateOld();
  setInterval(() => maybeRefresh("planifié"), 15 * 60e3).unref();
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { store.flush(); process.exit(0); });

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
