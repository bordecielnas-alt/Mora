// Mora — interface. Parle au serveur local via /api.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ICON = {
  article: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  podcast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  lien: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
};
const HEART = '<path d="M12 21s-7.5-4.6-9.3-9.2C1.4 8.4 3.6 5 7 5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.6 3.4 4.3 6.8C19.5 16.4 12 21 12 21z"/>';
const BOOKMARK = '<path d="M6 4h12v17l-6-4.5L6 21z"/>';
const TYPE_LABEL = { article: "Article", video: "Vidéo", podcast: "Podcast", lien: "Lien" };
const hueOf = (t) => { let h = 0; for (const c of String(t)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const grad = (t) => { const a = hueOf(t); return `linear-gradient(135deg,hsl(${a} 55% 36%),hsl(${(a + 35) % 360} 60% 50%))`; };
const initials = (s) => String(s).replace(/^(YouTube|Radio France|France Culture|Le Monde)\s*·\s*/, "").split(/[\s.·]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
const ago = (iso) => {
  if (!iso) return "";
  const h = (Date.now() - Date.parse(iso)) / 3600e3;
  if (h < 1) return "trouvé à l’instant";
  if (h < 24) return `trouvé il y a ${Math.round(h)} h`;
  return `trouvé il y a ${Math.round(h / 24)} j`;
};

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    method: opts.method || "GET",
    headers: opts.body ? { "content-type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.auth) { location.replace("/login"); throw new Error("Connecte-toi."); } // session expirée
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
function toast(m, action) {
  const t = $("#toast");
  t.innerHTML = esc(m) + (action ? `<button type="button">${esc(action.label)}</button>` : "");
  t.classList.toggle("act", !!action);
  if (action) t.querySelector("button").onclick = () => { t.classList.remove("on", "act"); action.run(); };
  t.classList.add("on"); clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("on", "act"), action ? 4500 : 1800);
}

const state = { stream: [], status: {}, kept: [], themes: [], weights: { theme: {}, type: {} }, decisions: 0, loading: false, prefs: null, langs: {}, hidden: [],
  suggestions: [], quests: [], justTossed: null, maxMin: 0, exhausted: false };
const SHARE = '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>';
const REASONS = [["seen", "Déjà vu"], ["long", "Trop long"], ["source", "Source bof"], ["topic", "Sujet hors cible"], ["basic", "Trop basique"]];
// Durée en minutes (« 8 min », « 12:30 », « 1:02:00 », « 1 h 20 ») ; null si inconnue. Même règle que le serveur.
function durationMin(d) {
  const s = String(d || "").toLowerCase().trim(); let m;
  if ((m = s.match(/^(\d+):(\d{1,2}):(\d{2})$/))) return +m[1] * 60 + +m[2] + +m[3] / 60;
  if ((m = s.match(/^(\d+):(\d{2})$/))) return +m[1] + +m[2] / 60;
  if ((m = s.match(/(\d+)\s*h(?:eures?)?\s*(\d+)?/))) return +m[1] * 60 + (+m[2] || 0);
  if ((m = s.match(/(\d+)\s*(?:min|mn|minutes?)/))) return +m[1];
  if ((m = s.match(/^(\d+)$/))) return +m[1];
  return null;
}
const fits = (p) => !state.maxMin || (durationMin(p.duration) ?? Infinity) <= state.maxMin;
const findItem = (id) => state.stream.find((x) => x.id === id) || state.quests.flatMap((q) => q.items).find((x) => x.id === id);

/* ---------------- Pour toi ---------------- */
function postHTML(p) {
  if (p.status === "toss") return tossedHTML(p);
  const kept = p.status === "keep", liked = !!p.liked;
  const orig = p.titleOriginal ? ` title="Titre original : ${esc(p.titleOriginal)}"` : "";
  const v = videoOf(p.url), pic = p.image || v?.thumb;
  const img = pic ? `<img src="${esc(pic)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.remove('has-img');this.remove()">` : "";
  return `<article class="post" data-id="${p.id}">
    <div class="ph"><span class="avatar" style="background:${grad(p.source)}">${esc(initials(p.source))}</span>
      <span class="who"><b>${esc(p.source)}</b><span>${TYPE_LABEL[p.type] || "Lien"} · ${ago(p.foundAt)}</span></span><span class="chip${p.theme === "Hors bulle" ? " out" : ""}">${esc(p.theme)}</span></div>
    <div class="media${img ? " has-img" : ""}" style="background:${grad(p.theme)}" data-dbl="${p.id}" data-open="${esc(p.url)}"${v ? ` data-embed="${esc(v.embed)}"` : ""} title="Touche pour ouvrir, double-tape pour aimer">
      ${img}<span class="big">${ICON[p.type] || ICON.lien}</span>
      <span class="type">${ICON[p.type] || ICON.lien}${TYPE_LABEL[p.type] || "Lien"}</span>${p.duration ? `<span class="dur">${esc(p.duration)}</span>` : ""}
      <span class="pop"><svg viewBox="0 0 24 24"><g fill="currentColor">${HEART}</g></svg></span></div>
    <div class="pb"><h3 class="title"${orig}><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a></h3>${p.excerpt ? `<p class="excerpt">${esc(p.excerpt)}</p>` : ""}
      ${p.why ? `<span class="why">Pourquoi ça : <b>${esc(p.why)}</b></span>` : ""}</div>
    <div class="acts">
      <button class="act like" data-like="${p.id}" aria-pressed="${liked}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">${HEART}</svg>J’aime</button>
      <button class="act" data-toss="${p.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>Pas pour moi</button>
      <button class="act keep" data-keep="${p.id}" aria-pressed="${kept}" aria-label="${kept ? "Retirer des gardés" : "Garder"}" title="${kept ? "Gardé" : "Garder pour plus tard"}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">${BOOKMARK}</svg></button>
      <button class="act icon" data-share="${p.id}" aria-label="Partager" title="Partager"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SHARE}</svg></button>
      <a class="act open" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" aria-label="Ouvrir la source"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a>
    </div></article>`;
}

function tossedHTML(p) {
  const done = p.reason && REASONS.find(([k]) => k === p.reason);
  return `<div class="hiddenpost" data-id="${p.id}">
    <div class="hrow"><span>${done ? `Merci, noté : « ${done[1].toLowerCase()} ».` : "Masqué. Pourquoi ? (facultatif)"}</span><button data-undo="${p.id}">Annuler</button></div>
    ${done ? "" : `<div class="reasons">${REASONS.map(([k, l]) => `<button data-reason="${k}" data-rid="${p.id}">${l}</button>`).join("")}</div>`}</div>`;
}

function renderBanner() {
  const s = state.status;
  let html = "";
  if (s.needsLogin)
    html = `<div class="banner">Ce sont des contenus d’exemple. Connecte ton compte Claude pour recevoir de vraies propositions trouvées sur le web.<br><button class="btn" id="bannerLogin">Connecter mon compte Claude</button></div>`;
  else if (s.mode === "demo")
    html = `<div class="banner">Mode démo : ce sont des contenus d’exemple. Claude Code est introuvable : lance <code>npm install</code> dans le dossier de l’app, puis relance-la.</div>`;
  else if (s.lastError && (!s.lastRefresh || s.lastError.at > s.lastRefresh))
    html = `<div class="banner err">La dernière recherche a échoué : ${esc(s.lastError.message)}. Réessaie avec le bouton ↻.</div>`;
  const sg = state.suggestions[0];
  if (sg) html += `<div class="banner sugg"><span>Mora te propose un nouveau thème : <b>${esc(sg.name)}</b>${sg.why ? `<br><span class="small">${esc(sg.why)}</span>` : ""}</span>
    <span class="row2"><button class="btn" data-sugg="${esc(sg.name)}" data-act="accept">Suivre ce thème</button><button class="btn ghost" data-sugg="${esc(sg.name)}" data-act="dismiss">Non merci</button></span></div>`;
  $("#banner").innerHTML = html;
  $("#banner").querySelectorAll("[data-sugg]").forEach((b) => (b.onclick = () => answerSuggestion(b.dataset.sugg, b.dataset.act)));
  const bl = $("#bannerLogin"); if (bl) bl.onclick = () => { showTab("themes"); connectAccount(); };
  $("#refreshBtn").classList.toggle("spin", !!s.refreshing);
  $("#refreshBtn").hidden = s.mode === "demo";
}

/* ---------------- Vidéos : miniature et lecture auto ---------------- */
// YouTube et Vimeo : miniature déduite du lien, et lecteur intégré lancé en muet quand la vidéo est bien visible.
function videoOf(url) {
  let u; try { u = new URL(url); } catch { return null; }
  const h = u.hostname.replace(/^(www|m|music)\./, "");
  let id = null;
  if (h === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (h === "youtube.com" || h === "youtube-nocookie.com") id = u.searchParams.get("v") || (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/) || [])[1];
  if (id && /^[\w-]{6,}$/.test(id)) {
    const t = Number(String(u.searchParams.get("t") || u.searchParams.get("start") || "0").replace(/s$/, "")) || 0;
    return { thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      embed: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1${t ? `&start=${t}` : ""}` };
  }
  const vm = h === "vimeo.com" && u.pathname.match(/^\/(\d+)/);
  if (vm) return { thumb: null, embed: `https://player.vimeo.com/video/${vm[1]}?autoplay=1&muted=1&playsinline=1&dnt=1` };
  return null;
}
const autoplayOn = () => state.prefs?.autoplay !== false;
let playing = null; // .media qui joue
const ratios = new Map();
const videoObs = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  entries.forEach((e) => ratios.set(e.target, e.isIntersecting ? e.intersectionRatio : 0));
  pickVideo();
}, { root: $("main"), threshold: [0, 0.3, 0.6, 0.9] }) : null;
function pickVideo() {
  let best = null, r = 0.6;
  for (const [el, v] of ratios) { if (!el.isConnected) { ratios.delete(el); continue; } if (v >= r) { best = el; r = v; } }
  const off = !autoplayOn() || $("#v-tri").hidden;
  const cur = playing?.isConnected ? ratios.get(playing) || 0 : 0;
  if (playing && (off || cur < 0.3)) stopVideo(playing); // on garde la vidéo en cours tant qu'elle reste un peu visible
  if (!off && best && !playing) playVideo(best);
}
function playVideo(m) {
  if (playing) stopVideo(playing);
  const f = document.createElement("iframe");
  f.src = m.dataset.embed; f.className = "embed"; f.title = "Lecture de la vidéo";
  f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen"; f.allowFullscreen = true;
  f.referrerPolicy = "strict-origin-when-cross-origin";
  m.appendChild(f); m.classList.add("playing"); playing = m;
}
function stopVideo(m) { m.querySelector("iframe.embed")?.remove(); m.classList.remove("playing"); if (playing === m) playing = null; }
function observeVideos() { if (videoObs) $("#stream").querySelectorAll(".media[data-embed]").forEach((m) => videoObs.observe(m)); }

// Met à jour le fil sans tout reconstruire : un post inchangé garde son nœud (et sa vidéo en cours),
// un post modifié garde sa zone vidéo si elle n'a pas changé.
function patchList(box, items) {
  const tpl = document.createElement("template");
  const old = new Map([...box.children].map((el) => [el.dataset.id, el]));
  let cursor = box.firstElementChild;
  for (const p of items) {
    const html = postHTML(p);
    let el = old.get(p.id);
    if (el && el._html !== html) {
      tpl.innerHTML = html.trim();
      const fresh = tpl.content.firstElementChild;
      const om = el.querySelector(".media"), nm = fresh.querySelector(".media");
      if (el.tagName === fresh.tagName && om && nm && om.dataset.embed && om.dataset.embed === nm.dataset.embed && om.dataset.open === nm.dataset.open) {
        // garde la zone vidéo (un iframe déplacé se recharge) : on remplace seulement ce qu'il y a autour
        [...el.children].forEach((c) => c !== om && c.remove());
        let before = true;
        for (const c of [...fresh.children]) {
          if (c === nm) { before = false; continue; }
          before ? el.insertBefore(c, om) : el.appendChild(c);
        }
      } else { el.replaceWith(fresh); if (el === cursor) cursor = fresh; el = fresh; }
      el._html = html;
    }
    if (!el) { tpl.innerHTML = html.trim(); el = tpl.content.firstElementChild; el._html = html; }
    old.delete(p.id);
    if (el !== cursor) box.insertBefore(el, cursor); else cursor = cursor.nextElementSibling;
  }
  for (const el of old.values()) { if (el.querySelector(".playing")) stopVideo(el.querySelector(".playing")); el.remove(); }
}

function renderStream() {
  // Les masqués quittent le fil (sauf celui qu'on vient de masquer, le temps de donner une raison).
  state.stream = state.stream.filter((p) => (p.status !== "toss" || p.id === state.justTossed) && p.status !== "removed");
  const shown = state.stream.filter((p) => p.status === "toss" || fits(p));
  patchList($("#stream"), shown);
  observeVideos(); observeSeen();
  $("#timeFilter").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", Number(b.dataset.min) === state.maxMin));
  const s = state.status;
  const more = $("#more");
  if (state.maxMin && state.exhausted)
    more.innerHTML = `<strong>C’est tout pour ${state.maxMin} min</strong><span>${shown.length ? "Rien d’autre ne tient dans ce temps pour l’instant." : "Aucune proposition ne tient dans ce temps pour l’instant."} Les contenus sans durée connue sont cachés avec ce filtre.</span><button class="btn ghost" id="noTime">Tout afficher</button>`;
  else if (s.pending > 0) more.innerHTML = `<span>Chargement des propositions suivantes…</span>`;
  else if (s.refreshing) more.innerHTML = `<strong>Recherche en cours</strong><span>L’IA cherche de nouveaux contenus sur le web. Ça prend une à deux minutes.</span>`;
  else if (s.mode === "ia") more.innerHTML = `<strong>Tu es à jour</strong><span>De nouvelles propositions arrivent automatiquement. Tu peux aussi lancer une recherche maintenant.</span><button class="btn" id="refill">Chercher maintenant</button>`;
  else more.innerHTML = `<strong>Tu es à jour</strong><span>Tu as vu tous les contenus d’exemple.</span>`;
  const rf = $("#refill"); if (rf) rf.onclick = startRefresh;
  const nt = $("#noTime"); if (nt) nt.onclick = () => setMaxMin(0);
  const kept = state.stream.filter((p) => p.status === "keep").length;
  const liked = state.stream.filter((p) => p.liked).length;
  $("#count").textContent = `${liked} j’aime · ${kept} gardés · ${s.pending ?? 0} à venir`;
  renderBanner();
}

async function loadMore() {
  if (state.loading || !(state.status.pending > 0) || (state.maxMin && state.exhausted)) return;
  state.loading = true;
  try {
    const r = await api("/stream/next", { method: "POST", body: { maxMin: state.maxMin } });
    addToStream(r.items);
    if (state.maxMin && !r.items.length) state.exhausted = true;
    state.status = r;
    renderStream();
  } catch (e) { toast(e.message); }
  finally { state.loading = false; checkSentinel(); }
}
function addToStream(items) { state.stream.push(...items); }

// Après une recherche, on va chercher tout de suite la première page de nouveautés, même sans faire défiler.
async function loadNewest() {
  if (state.loading) return;
  state.exhausted = false;
  await loadMore();
}
// « Déjà vu » : un post resté au moins 1,5 s à l'écran est signalé au serveur. Il reste affiché
// pendant cette visite, mais ne reviendra plus dans le fil au prochain chargement.
const seenSent = new Set(), seenQueue = new Set(), seenTimers = new Map();
function flushSeen(beacon = false) {
  if (!seenQueue.size) return;
  const ids = [...seenQueue]; seenQueue.clear();
  const body = JSON.stringify({ ids });
  if (beacon && navigator.sendBeacon) navigator.sendBeacon("/api/items/seen", new Blob([body], { type: "application/json" }));
  else api("/items/seen", { method: "POST", body: { ids } }).catch(() => ids.forEach((i) => seenQueue.add(i)));
}
const seenObs = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    const id = e.target.dataset.id; if (!id || seenSent.has(id)) continue;
    if (e.isIntersecting && e.intersectionRatio >= 0.6) {
      if (!seenTimers.has(id)) seenTimers.set(id, setTimeout(() => { seenTimers.delete(id); seenSent.add(id); seenQueue.add(id); }, 1500));
    } else { clearTimeout(seenTimers.get(id)); seenTimers.delete(id); }
  }
}, { root: $("main"), threshold: [0, 0.6] }) : null;
function observeSeen() { if (seenObs) $("#stream").querySelectorAll(".post[data-id]").forEach((el) => { if (!seenSent.has(el.dataset.id)) seenObs.observe(el); }); }
setInterval(() => flushSeen(), 4000);
addEventListener("pagehide", () => flushSeen(true));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSeen(true); });

// « J'ai X minutes » : ne montre que ce qui tient dans ce temps.
function setMaxMin(v) {
  state.maxMin = v; state.exhausted = false;
  try { localStorage.setItem("mora-maxmin", String(v)); } catch {}
  renderStream(); checkSentinel();
}
$("#timeFilter").addEventListener("click", (e) => { const b = e.target.closest("[data-min]"); if (b) setMaxMin(Number(b.dataset.min)); });
try { state.maxMin = Number(localStorage.getItem("mora-maxmin")) || 0; } catch {}

function checkSentinel() {
  const m = $("main"), r = $("#more").getBoundingClientRect(), mr = m.getBoundingClientRect();
  if (!$("#v-tri").hidden && r.top < mr.bottom + 300) loadMore();
}

function renderAllPosts() { renderStream(); renderQuests(); }

let tossTimer = null;
async function decide(id, decision) {
  const p = findItem(id); if (!p) return;
  const cur = p.status === "keep" ? "keep" : p.status === "toss" ? "toss" : "none";
  if (cur === decision) decision = "none";
  try {
    const it = await api(`/items/${id}/decision`, { method: "POST", body: { decision } });
    Object.assign(p, it);
    if (decision === "toss") {
      state.justTossed = id; clearTimeout(tossTimer);
      tossTimer = setTimeout(() => { if (state.justTossed === id) { state.justTossed = null; renderAllPosts(); } }, 12000);
    }
    renderAllPosts();
    if (decision === "keep") toast("Ajouté à tes gardés");
    loadKept(); loadThemes(); loadHidden();
  } catch (e) { toast(e.message); }
}
async function setReason(id, reason) {
  const p = findItem(id); if (!p) return;
  try {
    Object.assign(p, await api(`/items/${id}/reason`, { method: "POST", body: { reason } }));
    renderAllPosts(); loadThemes();
    clearTimeout(tossTimer);
    tossTimer = setTimeout(() => { if (state.justTossed === id) { state.justTossed = null; renderAllPosts(); } }, 1800);
  } catch (e) { toast(e.message); }
}

async function like(id, liked) {
  const p = findItem(id); if (!p) return;
  if (liked === undefined) liked = !p.liked;
  if (!!p.liked === liked) return;
  try {
    const it = await api(`/items/${id}/like`, { method: "POST", body: { liked } });
    Object.assign(p, it);
    renderAllPosts();
    loadThemes();
  } catch (e) { toast(e.message); }
}

// Partage : menu de partage du téléphone, sinon copie du lien.
async function share(p) {
  if (!p) return;
  const data = { title: p.title, text: p.title + (p.source ? ` (${p.source})` : ""), url: p.url };
  if (navigator.share) { try { await navigator.share(data); } catch {} return; }
  try { await navigator.clipboard.writeText(`${p.title}\n${p.url}`); toast("Lien copié"); }
  catch { prompt("Copie ce lien :", p.url); }
}

// Un toucher sur l'image ouvre le contenu dans un nouvel onglet ; un double-toucher l'aime.
// On attend un court instant avant d'ouvrir, pour laisser passer un éventuel deuxième toucher.
let openTimer = null;
function onPostsClick(e) {
  const c = (sel) => e.target.closest(sel);
  let x;
  if ((x = c("[data-like]"))) like(x.dataset.like);
  else if ((x = c("[data-keep]"))) decide(x.dataset.keep, "keep");
  else if ((x = c("[data-toss]"))) decide(x.dataset.toss, "toss");
  else if ((x = c("[data-undo]"))) { state.justTossed = null; decide(x.dataset.undo, "none"); }
  else if ((x = c("[data-reason]"))) setReason(x.dataset.rid, x.dataset.reason);
  else if ((x = c("[data-share]"))) share(findItem(x.dataset.share));
  else if ((x = c("[data-open]"))) {
    clearTimeout(openTimer);
    if (e.detail > 1) return; // deuxième toucher : c'est un double-tap
    openTimer = setTimeout(() => window.open(x.dataset.open, "_blank", "noopener,noreferrer"), 280);
  }
}
function onPostsDbl(e) {
  const m = e.target.closest("[data-dbl]"); if (!m) return;
  clearTimeout(openTimer);
  const pop = m.querySelector(".pop"); pop.classList.add("on"); setTimeout(() => pop.classList.remove("on"), 600);
  const p = findItem(m.dataset.dbl);
  if (p && !p.liked) setTimeout(() => like(p.id, true), 300);
}
for (const el of [$("#stream"), $("#questList")]) { el.addEventListener("click", onPostsClick); el.addEventListener("dblclick", onPostsDbl); }
$("main").addEventListener("scroll", checkSentinel, { passive: true });

async function startRefresh() {
  try { state.status = await api("/refresh", { method: "POST" }); renderStream(); toast("Recherche lancée"); pollStatus(); }
  catch (e) { toast(e.message); }
}
$("#refreshBtn").onclick = startRefresh;

let pollTimer = null, wasTranslating = false, wasQuesting = false;
async function reloadTitles() {
  try {
    const r = await api("/stream");
    const byId = new Map(r.items.map((i) => [i.id, i]));
    state.stream.forEach((p) => { const n = byId.get(p.id); if (n) { p.title = n.title; p.titleOriginal = n.titleOriginal; } });
    renderStream(); loadKept();
  } catch {}
}
function pollStatus() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      const was = state.status.pending, wasRefreshing = state.status.refreshing;
      state.status = await api("/status");
      renderStream(); renderQuests();
      if (wasRefreshing && !state.status.refreshing && state.status.pending > (was || 0)) loadNewest();
      else if (state.status.pending > (was || 0) && !state.loading) checkSentinel();
    } catch {}
    if (state.status.translating) wasTranslating = true;
    else if (wasTranslating) { wasTranslating = false; reloadTitles(); }
    if (wasQuesting && !state.status.questing) loadQuests();
    wasQuesting = !!state.status.questing;
    if (state.status.refreshing || state.status.translating || state.status.questing) pollStatus();
  }, 4000);
}

/* ---------------- Gardés ---------------- */
let filter = "tout", themeFilter = "tout", query = "";
const norm = (x) => String(x ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
async function loadKept() { try { state.kept = await api("/kept"); renderKept(); } catch (e) { toast(e.message); } }
function renderKept() {
  // Filtres par centre d'intérêt : seulement les thèmes qui ont des gardés.
  const counts = {};
  state.kept.forEach((f) => (counts[f.theme] = (counts[f.theme] || 0) + 1));
  const themes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (themeFilter !== "tout" && !counts[themeFilter]) themeFilter = "tout";
  $("#themeFilters").innerHTML = [`<button aria-pressed="${themeFilter === "tout"}" data-tf="tout">Tous les thèmes</button>`,
    ...themes.map((t) => `<button aria-pressed="${t === themeFilter}" data-tf="${esc(t)}">${esc(t)} <span class="n">${counts[t]}</span></button>`)].join("");
  $("#themeFilters").querySelectorAll("button").forEach((b) => (b.onclick = () => { themeFilter = b.dataset.tf; renderKept(); }));
  const types = ["tout", "star", "article", "video", "podcast", "lien"];
  const lbl = { tout: "Tous formats", star: "★ Favoris", ...TYPE_LABEL };
  $("#filters").innerHTML = types.map((t) => `<button aria-pressed="${t === filter}" data-f="${t}">${lbl[t]}</button>`).join("");
  $("#filters").querySelectorAll("button").forEach((b) => (b.onclick = () => { filter = b.dataset.f; renderKept(); }));
  const words = norm(query).split(/\s+/).filter(Boolean);
  const list = state.kept.filter((f) =>
    (filter === "tout" || (filter === "star" ? f.star : f.type === filter)) &&
    (themeFilter === "tout" || f.theme === themeFilter) &&
    (!words.length || words.every((w) => norm([f.title, f.titleOriginal, f.excerpt, f.note, f.source, f.theme].join(" ")).includes(w))));
  $("#feedcount").textContent = list.length === state.kept.length ? `${state.kept.length} gardés` : `${list.length} sur ${state.kept.length}`;
  $("#feed").innerHTML = list.length
    ? list.map((f) => `<button class="item" data-id="${f.id}">
        <span class="mini" style="background:${grad(f.theme)}">${ICON[f.type] || ICON.lien}</span>
        <span class="meta"><span class="src"><span class="chip">${esc(f.theme)}</span>${TYPE_LABEL[f.type] || "Lien"}${f.duration ? " · " + esc(f.duration) : ""}${f.star ? ' <span class="star">★</span>' : ""}</span>
          <span class="t">${esc(f.title)}</span><span class="src">${esc(f.source)}</span>
          ${f.note ? `<span class="note">${esc(f.note)}</span>` : ""}</span></button>`).join("")
    : state.kept.length
      ? `<div class="feedempty">Aucun gardé ne correspond${query ? ` à « ${esc(query)} »` : ""}.</div>`
      : `<div class="feedempty">Rien ici pour l’instant. Touche le signet sur un post dans l’onglet Pour toi pour le garder ici.</div>`;
  $("#feed").querySelectorAll(".item").forEach((b) => (b.onclick = () => openSheet(b.dataset.id)));
}
$("#keptSearch").addEventListener("input", (e) => { query = e.target.value.trim(); renderKept(); });

function openSheet(id) {
  const f = state.kept.find((x) => x.id === id); if (!f) return;
  const sc = document.createElement("div"); sc.className = "scrim";
  sc.innerHTML = `<div class="sheet" role="dialog" aria-label="Affiner ce contenu"><div class="grab"></div>
    <div class="src"><span class="chip">${esc(f.theme)}</span>${TYPE_LABEL[f.type] || "Lien"} · ${esc(f.source)}</div>
    <h2>${esc(f.title)}</h2>${f.titleOriginal ? `<p class="small orig">Titre original : ${esc(f.titleOriginal)}</p>` : ""}
    <a class="btn ghost" style="text-align:center;text-decoration:none" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">Ouvrir la source</a>
    <label for="noteIn">Ma note</label>
    <textarea id="noteIn" placeholder="Pourquoi je l’ai gardé, ce que j’en retiens…">${esc(f.note || "")}</textarea>
    <label>Thème</label>
    <div class="taglist">${state.themes.map((t) => `<button aria-pressed="${t === f.theme}" data-t="${esc(t)}">${esc(t)}</button>`).join("")}</div>
    <div class="actions">
      <button class="btn" id="saveS">Enregistrer</button>
      <button class="btn ghost" id="shareS">Partager</button>
      <button class="btn ghost" id="starS">${f.star ? "Retirer des favoris" : "★ Favori"}</button>
      <button class="btn danger" id="delS">Retirer des gardés</button>
    </div></div>`;
  document.body.appendChild(sc);
  let theme = f.theme;
  sc.querySelectorAll(".taglist button").forEach((b) => (b.onclick = () => { theme = b.dataset.t; sc.querySelectorAll(".taglist button").forEach((x) => x.setAttribute("aria-pressed", x === b)); }));
  const close = () => sc.remove();
  sc.onclick = (e) => { if (e.target === sc) close(); };
  sc.querySelector("#saveS").onclick = async () => { await api(`/items/${id}`, { method: "PATCH", body: { note: sc.querySelector("#noteIn").value.trim(), theme } }); close(); loadKept(); toast("Contenu affiné"); };
  sc.querySelector("#shareS").onclick = () => share(f);
  sc.querySelector("#starS").onclick = async () => { await api(`/items/${id}`, { method: "PATCH", body: { star: !f.star } }); close(); loadKept(); };
  sc.querySelector("#delS").onclick = async () => {
    await api(`/kept/${id}`, { method: "DELETE" });
    const s = state.stream.find((x) => x.id === id); if (s) { s.status = "removed"; state.stream = state.stream.filter((x) => x !== s); renderStream(); }
    close(); loadKept(); loadThemes(); toast("Retiré, le feed en tient compte");
  };
}

/* ---------------- Thèmes ---------------- */
async function loadThemes() {
  try { const r = await api("/themes"); state.themes = r.themes; state.weights = r.weights; state.decisions = r.decisions; state.suggestions = r.suggestions || []; renderThemes(); renderBanner(); } catch {}
}
async function answerSuggestion(name, act) {
  try {
    const r = await api(`/suggestions/${encodeURIComponent(name)}/${act}`, { method: "POST" });
    state.themes = r.themes; state.weights = r.weights; state.suggestions = r.suggestions;
    renderThemes(); renderBanner();
    toast(act === "accept" ? `Nouveau thème : ${name}` : "Suggestion écartée");
    if (act === "accept") { refreshStatus(); pollStatus(); }
  } catch (e) { toast(e.message); }
}
function renderThemes() {
  $("#themes").innerHTML = state.themes.map((t) => `<span>${esc(t)}<button aria-label="Retirer ${esc(t)}" data-t="${esc(t)}">×</button></span>`).join("");
  $("#suggList").innerHTML = state.suggestions.length
    ? `<p class="small">Suggérés d’après tes gardés :</p><div class="themes">${state.suggestions.map((x) => `<span class="sugg" title="${esc(x.why)}">${esc(x.name)}<button aria-label="Suivre ${esc(x.name)}" data-sugg="${esc(x.name)}" data-act="accept">+</button><button aria-label="Écarter ${esc(x.name)}" data-sugg="${esc(x.name)}" data-act="dismiss">×</button></span>`).join("")}</div>`
    : "";
  $("#suggList").querySelectorAll("[data-sugg]").forEach((b) => (b.onclick = () => answerSuggestion(b.dataset.sugg, b.dataset.act)));
  $("#themes").querySelectorAll("button").forEach((b) => (b.onclick = async () => {
    const r = await api(`/themes/${encodeURIComponent(b.dataset.t)}`, { method: "DELETE" });
    state.themes = r.themes; state.weights = r.weights; renderThemes(); refreshStatus(); toast("Thème retiré");
  }));
  const s = state.status;
  $("#statusLine").textContent = s.mode === "ia"
    ? `Recherche via ${s.model}. Dernière recherche : ${s.lastRefresh ? new Date(s.lastRefresh).toLocaleString("fr-FR") : "jamais"}. ${s.pending} propositions en réserve.`
    : s.needsLogin ? "Contenus d’exemple tant que ton compte Claude n’est pas connecté (en haut de cette page)."
    : "Mode démo : Claude Code est introuvable. Lance npm install dans le dossier de l’app.";
}
$("#addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("#newTheme").value.trim(); if (!v) return;
  try {
    const r = await api("/themes", { method: "POST", body: { name: v } });
    state.themes = r.themes; state.weights = r.weights; $("#newTheme").value = ""; renderThemes();
    toast(`L’IA cherchera aussi : ${v}`); refreshStatus(); pollStatus();
  } catch (err) { toast(err.message); }
});

/* ---------------- Réglages : recherche ---------------- */
const LANG_FR = { fr: "Français", en: "Anglais", es: "Espagnol", de: "Allemand", it: "Italien", pt: "Portugais" };
const MIX = [["article", "Articles"], ["video", "Vidéos"], ["podcast", "Podcasts"]];
async function loadPrefs() {
  try { const r = await api("/prefs"); state.prefs = r.prefs; state.langs = r.langs; applyLook(); renderPrefs(); } catch {}
}
let prefTimer = null, prefPatch = {};
function savePrefs(patch) {
  Object.assign(state.prefs, patch);
  Object.assign(prefPatch, patch); // regroupe les changements rapprochés
  clearTimeout(prefTimer);
  prefTimer = setTimeout(async () => {
    const body = prefPatch; prefPatch = {};
    try { const r = await api("/prefs", { method: "PATCH", body }); state.prefs = r.prefs; toast("Réglage enregistré"); }
    catch (e) { toast(e.message); }
  }, 250);
}
function renderPrefs() {
  const p = state.prefs; if (!p) return;
  const langs = Object.keys(state.langs || LANG_FR);
  const mixTotal = () => MIX.reduce((n, [k]) => n + (p.mix[k] || 0), 0) || 1;
  const mixPct = (k) => Math.round(((p.mix[k] || 0) / mixTotal()) * 100);
  const nativeLbl = () => `${LANG_FR[p.lang]} ${p.nativeShare} % · Anglais ${100 - p.nativeShare} %`;
  const bubbleLbl = () => p.bubble ? `${p.bubble} % de contenus hors de tes centres d’intérêt` : "Seulement tes thèmes";
  $("#searchPrefs").innerHTML = `
    <div class="pref"><label for="pLang">Langue des contenus</label>
      <p class="small">L’IA privilégie les contenus écrits à l’origine dans cette langue (pas des traductions).</p>
      <select id="pLang">${langs.map((l) => `<option value="${l}"${l === p.lang ? " selected" : ""}>${LANG_FR[l] || l}</option>`).join("")}</select></div>
    <div class="pref" id="nativeRow"${p.lang === "en" ? " hidden" : ""}><label for="pNative">Mélange avec l’anglais</label>
      <input type="range" id="pNative" min="0" max="100" step="5" value="${p.nativeShare}">
      <div class="ends"><span id="nativeLbl" class="mono">${nativeLbl()}</span></div></div>
    <div class="pref"><label>Formats recherchés</label>
      <p class="small">Le poids de chaque format dans les recherches. Mets un format à 0 pour ne plus en recevoir.</p>
      ${MIX.map(([k, l]) => `<div class="mixrow"><span>${l}</span><input type="range" min="0" max="100" step="5" data-mix="${k}" value="${p.mix[k] || 0}" aria-label="${l}"><span class="mono" data-mixv="${k}">${mixPct(k)} %</span></div>`).join("")}</div>
    <div class="pref"><label for="pBubble">Sortir de ma bulle</label>
      <p class="small">Une part de contenus choisis hors de tes thèmes, pour découvrir autre chose. Ils apparaissent avec le thème «&nbsp;Hors bulle&nbsp;».</p>
      <input type="range" id="pBubble" min="0" max="50" step="5" value="${p.bubble}">
      <div class="ends"><span id="bubbleLbl" class="mono">${bubbleLbl()}</span></div></div>`;
  const box = $("#searchPrefs");
  box.querySelector("#pLang").onchange = (e) => { savePrefs({ lang: e.target.value }); renderPrefs(); };
  const nat = box.querySelector("#pNative");
  nat.oninput = () => { p.nativeShare = Number(nat.value); box.querySelector("#nativeLbl").textContent = nativeLbl(); };
  nat.onchange = () => savePrefs({ nativeShare: Number(nat.value) });
  box.querySelectorAll("[data-mix]").forEach((r) => {
    r.oninput = () => {
      p.mix = { ...p.mix, [r.dataset.mix]: Number(r.value) };
      if (!MIX.some(([k]) => p.mix[k] > 0)) { r.value = 5; p.mix[r.dataset.mix] = 5; } // au moins un format
      MIX.forEach(([k]) => (box.querySelector(`[data-mixv="${k}"]`).textContent = `${mixPct(k)} %`));
    };
    r.onchange = () => savePrefs({ mix: { ...p.mix } });
  });
  const bub = box.querySelector("#pBubble");
  bub.oninput = () => { p.bubble = Number(bub.value); box.querySelector("#bubbleLbl").textContent = bubbleLbl(); };
  bub.onchange = () => savePrefs({ bubble: Number(bub.value) });
  renderRules();
  renderLook();
}

/* ---------------- Réglages : mes règles (mots-clés et sources) ---------------- */
const RULES = [
  ["blockedWords", "Mots-clés interdits", "Jamais de contenus sur ces sujets.", "ex. crypto"],
  ["blockedSources", "Sources bloquées", "Jamais de contenus de ces sites ou médias.", "ex. Medium"],
  ["pinnedSources", "Sources épinglées", "Suivies en priorité et remontées dans le fil.", "ex. Arrêt sur images"],
];
function renderRules() {
  const p = state.prefs; if (!p) return;
  $("#rulePrefs").innerHTML = RULES.map(([k, l, help, ph]) => `<div class="pref"><label>${l}</label><p class="small">${help}</p>
      <div class="themes">${(p[k] || []).map((v) => `<span>${esc(v)}<button aria-label="Retirer ${esc(v)}" data-rk="${k}" data-rv="${esc(v)}">×</button></span>`).join("")}</div>
      <form class="addtheme" data-rule="${k}"><input placeholder="${ph}" autocomplete="off" aria-label="${l}"><button class="btn ghost" type="submit">Ajouter</button></form></div>`).join("");
  $("#rulePrefs").querySelectorAll("[data-rk]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.rk; savePrefs({ [k]: p[k].filter((x) => x !== b.dataset.rv) }); renderRules();
  }));
  $("#rulePrefs").querySelectorAll("form[data-rule]").forEach((f) => (f.onsubmit = (e) => {
    e.preventDefault();
    const k = f.dataset.rule, v = f.querySelector("input").value.trim(); if (!v) return;
    if (!p[k].some((x) => x.toLowerCase() === v.toLowerCase())) savePrefs({ [k]: [...p[k], v] });
    renderRules(); $(`#rulePrefs form[data-rule="${k}"] input`).focus();
  }));
}

/* ---------------- Recherche ponctuelle ---------------- */
async function loadQuests() { try { state.quests = await api("/quests"); renderQuests(); } catch {} }
function renderQuests() {
  const box = $("#questList"); if (!box) return;
  const running = state.quests.some((q) => q.status === "running");
  $("#questForm button").disabled = running;
  box.innerHTML = state.quests.length ? state.quests.map((q) => {
    const items = q.items.filter((i) => i.status !== "toss" || i.id === state.justTossed);
    const head = `<div class="qhead"><div><b>${esc(q.q)}</b><span class="small"> · ${new Date(q.at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</span></div>
      ${q.status === "running" ? "" : `<button class="linkbtn" data-delq="${q.id}" aria-label="Effacer cette recherche">Effacer</button>`}</div>`;
    const body = q.status === "running" ? `<div class="waitbox"><span class="spinner"></span>L’IA cherche sur le web, une à trois minutes…</div>`
      : q.status === "error" ? `<div class="banner err">La recherche a échoué : ${esc(q.error)}</div>`
      : items.length ? `<div class="stream">${items.map(postHTML).join("")}</div>` : `<p class="small">Rien trouvé${q.found ? " d’autre" : ""}.</p>`;
    return `<section class="quest">${head}${body}</section>`;
  }).join("") : `<p class="small">Tes recherches ponctuelles apparaîtront ici. Elles ne créent pas de thème et ne changent pas ton fil.</p>`;
  box.querySelectorAll("[data-delq]").forEach((b) => (b.onclick = async () => { await api(`/quests/${b.dataset.delq}`, { method: "DELETE" }); loadQuests(); }));
}
$("#questForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#questIn").value.trim(); if (!q) return;
  try {
    const r = await api("/quests", { method: "POST", body: { q } });
    state.quests.unshift(r); $("#questIn").value = ""; renderQuests();
    state.status.questing = true; pollStatus();
  } catch (err) { toast(err.message); }
});
$("#questBtn").onclick = () => showTab("quest");

/* ---------------- Réglages : apparence ---------------- */
// Palettes définies dans themes.css (attribut data-palette). Pour en ajouter une : un bloc dans themes.css + une ligne ici.
const PALETTES = [
  ["lagune", "Lagune", "#0E6B6F"], ["mure", "Mûre", "#6E2A5E"], ["papier", "Papier", "#2340A0"],
  ["sauge", "Sauge", "#3D6A3F"], ["braise", "Braise", "#9A4A08"],
];
const MODES = [["auto", "Auto"], ["light", "Clair"], ["dark", "Sombre"]];
function applyLook() {
  const p = state.prefs; if (!p) return;
  const root = document.documentElement;
  if (p.mode && p.mode !== "auto") root.dataset.theme = p.mode; else delete root.dataset.theme;
  if (p.palette && p.palette !== "lagune") root.dataset.palette = p.palette; else delete root.dataset.palette;
  try { localStorage.setItem("mora-look", JSON.stringify({ mode: p.mode, palette: p.palette })); } catch {}
  const c = getComputedStyle(root).getPropertyValue("--theme-color").trim();
  if (c) document.querySelector('meta[name="theme-color"]').setAttribute("content", c);
}
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyLook);
function renderLook() {
  const p = state.prefs; if (!p) return;
  $("#lookPrefs").innerHTML = `
    <div class="pref"><label>Clair ou sombre</label>
      <div class="seg" role="radiogroup">${MODES.map(([k, l]) => `<button role="radio" aria-checked="${p.mode === k}" data-mode="${k}">${l}</button>`).join("")}</div></div>
    <div class="pref"><label class="switch"><input type="checkbox" id="pAutoplay"${p.autoplay !== false ? " checked" : ""}><span>Lecture auto des vidéos</span></label>
      <p class="small">YouTube et Vimeo se lancent en muet quand la vidéo est à l’écran. Touche le lecteur pour mettre le son.</p></div>
    <div class="pref"><label>Couleurs</label>
      <div class="palettes" role="radiogroup">${PALETTES.map(([k, l, c]) => `<button role="radio" aria-checked="${(p.palette || "lagune") === k}" data-pal="${k}"><span class="sw" style="background:${c}"></span>${l}</button>`).join("")}</div></div>`;
  $("#pAutoplay").onchange = (e) => { savePrefs({ autoplay: e.target.checked }); pickVideo(); };
  $("#lookPrefs").querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => { savePrefs({ mode: b.dataset.mode }); applyLook(); renderLook(); }));
  $("#lookPrefs").querySelectorAll("[data-pal]").forEach((b) => (b.onclick = () => { savePrefs({ palette: b.dataset.pal }); applyLook(); renderLook(); }));
}

/* ---------------- Réglages : masqués ---------------- */
const agoDays = (iso) => { const d = Math.floor((Date.now() - Date.parse(iso)) / 86400e3); return d < 1 ? "aujourd’hui" : d === 1 ? "hier" : `il y a ${d} j`; };
async function loadHidden() { try { state.hidden = await api("/hidden"); renderHidden(); } catch {} }
function renderHidden() {
  const box = $("#hiddenList");
  box.innerHTML = state.hidden.length
    ? state.hidden.map((h) => `<div class="hid"><div class="meta"><a class="t" href="${esc(h.url)}" target="_blank" rel="noopener noreferrer">${esc(h.title)}</a>
        <span class="src"><span class="chip">${esc(h.theme)}</span>${esc(h.source)} · masqué ${agoDays(h.decidedAt)}</span></div>
        <button class="btn ghost" data-restore="${h.id}">Remettre</button></div>`).join("")
    : `<p class="small">Rien de masqué ces 15 derniers jours.</p>`;
  box.querySelectorAll("[data-restore]").forEach((b) => (b.onclick = async () => {
    try {
      await api(`/items/${b.dataset.restore}/restore`, { method: "POST" });
      const r = await api("/stream"); state.stream = r.items; state.status = r;
      renderStream(); loadHidden(); loadThemes(); toast("Remis dans ton fil");
    } catch (e) { toast(e.message); }
  }));
}

/* ---------------- Stats ---------------- */
async function loadStats() { try { renderStats(await api("/stats")); } catch (e) { $("#stats").innerHTML = `<p class="small">${esc(e.message)}</p>`; } }
function renderStats(st) {
  const T = st.totals;
  $("#statsCount").textContent = `${T.decisions} choix`;
  const tiles = [["Vus", T.seen], ["J’aime", T.liked], ["Gardés", T.kept], ["Masqués", T.tossed]]
    .map(([l, v]) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`).join("");
  // Centres d'intérêt : poids appris (0,1 à 2) + compteurs.
  const themes = [...st.themes].sort((a, b) => b.weight - a.weight);
  const bars = themes.map((t) => `<div class="ibar"><div class="row"><span class="nm">${esc(t.theme)}</span>
      <span class="mono">${t.weight > 1.05 ? "↑" : t.weight < 0.95 ? "↓" : "="} ${t.weight.toFixed(2)}</span></div>
      <span class="track"><span class="fill${t.weight < 0.8 ? " low" : ""}" style="width:${(t.weight / 2) * 100}%"></span></span>
      <span class="small">${t.liked} j’aime · ${t.kept} gardés · ${t.tossed} masqués · ${t.seen} vus</span></div>`).join("");
  // Heatmap thème × format : intensité = contenus aimés ou gardés.
  const max = Math.max(1, ...st.grid.flat().map((c) => c.pos));
  const fl = { article: "Article", video: "Vidéo", podcast: "Podcast", lien: "Lien" };
  const heat = `<div class="heat" style="grid-template-columns:minmax(70px,1.3fr) repeat(${st.formats.length},1fr)">
      <span></span>${st.formats.map((f) => `<span class="hd">${fl[f]}</span>`).join("")}
      ${st.themes.map((t, r) => `<span class="rl">${esc(t.theme)}</span>${st.grid[r].map((c, k) => {
        const a = c.pos ? Math.round(18 + (c.pos / max) * 82) : 0;
        const bg = c.pos ? `color-mix(in srgb, var(--accent) ${a}%, var(--sunk))` : c.toss ? `color-mix(in srgb, var(--toss) 22%, var(--sunk))` : "var(--sunk)";
        const ink = a > 55 ? "var(--accent-ink)" : "var(--ink)";
        return `<span class="cell" style="background:${bg};color:${ink}" title="${esc(t.theme)} · ${fl[st.formats[k]]} : ${c.pos} aimés ou gardés, ${c.toss} masqués, ${c.seen} vus">${c.pos || (c.toss ? "–" : "")}</span>`;
      }).join("")}`).join("")}</div>
    <p class="small">Plus la case est foncée, plus tu as aimé ou gardé ce thème dans ce format. Une case rosée : surtout masqué.</p>`;
  // Activité des 12 dernières semaines (une colonne par semaine, lundi en haut).
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - 7 * 11);
  const vals = []; for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) vals.push([d.toISOString().slice(0, 10), st.days[d.toISOString().slice(0, 10)] || 0]);
  const amax = Math.max(1, ...vals.map((v) => v[1]));
  const act = `<div class="cal">${vals.map(([d, v]) => `<span title="${new Date(d).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })} : ${v} choix" style="background:${v ? `color-mix(in srgb, var(--accent) ${Math.round(25 + (v / amax) * 75)}%, var(--sunk))` : "var(--sunk)"}"></span>`).join("")}</div>
    <div class="ends small"><span>il y a 12 semaines</span><span>aujourd’hui</span></div>`;
  const W = st.weights.type || {};
  const fbars = Object.keys(fl).map((t) => { const v = W[t] ?? 1; return `<div class="bar"><span>${fl[t]}</span><span class="track"><span class="fill${v < 0.85 ? " low" : ""}" style="width:${(v / 1.7) * 100}%"></span></span><span class="v mono">${v.toFixed(2)}</span></div>`; }).join("");
  const L = st.language;
  const lang = L.known ? `<p class="small">${Math.round((L.native / L.known) * 100)} % des contenus vus sont nativement en ${esc((LANG_FR[L.lang] || L.lang).toLowerCase())} (sur ${L.known} dont la langue est connue).</p>` : "";
  $("#stats").innerHTML = `<div class="tiles">${tiles}</div>
    <h2 class="h3">Tes centres d’intérêt</h2><div class="block">${bars || '<p class="small">Ajoute des thèmes dans Réglages.</p>'}</div>
    <h2 class="h3">Thèmes × formats</h2><div class="block">${st.themes.length ? heat : '<p class="small">Pas encore de données.</p>'}</div>
    <h2 class="h3">Ton activité</h2><div class="block">${act}</div>
    <h2 class="h3">Formats appris</h2><div class="block"><div class="bars">${fbars}</div>${lang}</div>`;
}

async function refreshStatus() { try { state.status = await api("/status"); renderStream(); renderThemes(); } catch {} }

/* ---------------- Onglets ---------------- */
function showTab(v) {
  document.querySelectorAll("nav.tabs button").forEach((x) => x.setAttribute("aria-selected", x.dataset.v === v));
  ["tri", "feed", "stats", "themes", "quest"].forEach((k) => ($("#v-" + k).hidden = k !== v));
  $("#questBtn").setAttribute("aria-pressed", v === "quest");
  pickVideo();
  $("main").scrollTop = 0;
  if (v === "tri") checkSentinel();
  if (v === "themes") { loadAccount(); loadHidden(); loadMe(); }
  if (v === "stats") loadStats();
  if (v === "quest") { loadQuests(); setTimeout(() => $("#questIn").focus(), 50); }
}
document.querySelectorAll("nav.tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.v)));

/* ---------------- Compte Claude ---------------- */
let acct = null, acctTimer = null, wasLoggedIn = null;
async function loadAccount() {
  try { acct = await api("/account"); } catch (e) { acct = { error: e.message }; }
  renderAccount();
  if (wasLoggedIn === false && acct.loggedIn) onConnected();
  wasLoggedIn = !!acct.loggedIn;
  clearTimeout(acctTimer);
  if (["starting", "waiting", "checking"].includes(acct.login?.state)) acctTimer = setTimeout(loadAccount, 2000);
}
async function onConnected() {
  try {
    const r = await api("/account/connected", { method: "POST" });
    state.status = r;
    state.stream = state.stream.filter((p) => !(p.demo && p.status === "shown"));
    renderStream(); renderThemes();
    toast("Compte connecté, première recherche lancée");
    pollStatus();
  } catch (e) { toast(e.message); }
}
async function connectAccount() {
  try { await api("/account/login", { method: "POST" }); } catch (e) { toast(e.message); }
  loadAccount();
}
let acctSig = "";
function renderAccount() {
  const box = $("#accountBlock"); if (!box || !acct) return;
  const a = acct, L = a.login || {};
  const sig = JSON.stringify([a.error, a.backend, a.installed, a.loggedIn, a.email, L.state, L.url, L.error]);
  if (sig === acctSig) return; // ne pas effacer le code en cours de saisie
  acctSig = sig;
  let h = "";
  if (a.error) h = `<div class="state"><span class="dot err"></span>Impossible de lire l’état du compte</div><p class="small">${esc(a.error)}</p>`;
  else if (a.backend === "api") h = `<div class="state"><span class="dot ok"></span>Recherche via une clé API</div><p class="small">La clé est lue dans le fichier .env. Retire-la pour utiliser ton abonnement Claude.</p>`;
  else if (!a.installed) h = `<div class="state"><span class="dot err"></span>Claude Code introuvable</div><p class="small">Lance <code>npm install</code> dans le dossier de l’app, puis relance-la.</p>`;
  else if (a.loggedIn) h = `<div class="state"><span class="dot ok"></span>Compte Claude connecté</div>
      <p class="small">${a.email ? esc(a.email) + " · " : ""}${a.subscription ? "abonnement " + esc(a.subscription) + " · " : ""}Les recherches comptent dans les limites de ton abonnement.</p>
      <div class="row2"><button class="btn ghost" id="acLogout">Déconnecter</button></div>`;
  else if (L.state === "waiting") h = `<div class="state"><span class="dot wait"></span>Connexion en cours</div>
      <ol><li><a class="btn" href="${esc(L.url)}" target="_blank" rel="noopener noreferrer">Ouvrir la page de connexion Claude</a></li>
        <li>Connecte-toi avec ton compte Claude et autorise l’accès.</li>
        <li>Copie le code affiché à la fin, puis colle-le ici :</li></ol>
      <form class="codeRow" id="acCodeForm"><input id="acCode" placeholder="Colle le code ici" autocomplete="off" spellcheck="false"><button class="btn" type="submit">Valider</button></form>
      <div class="row2"><button class="btn ghost" id="acCancel" type="button">Annuler</button></div>`;
  else if (L.state === "starting" || L.state === "checking") h = `<div class="state"><span class="dot wait"></span>${L.state === "checking" ? "Vérification du code…" : "Préparation de la connexion…"}</div>`;
  else h = `<div class="state"><span class="dot"></span>Compte Claude non connecté</div>
      <p class="small">Mora utilise ton abonnement Claude (Pro ou Max) pour chercher des contenus sur le web. Aucune clé API, aucun paiement en plus.</p>
      ${L.state === "error" ? `<div class="banner err">${esc(L.error)}</div>` : ""}
      <div class="row2"><button class="btn" id="acLogin">${L.state === "error" ? "Réessayer" : "Connecter mon compte Claude"}</button></div>`;
  box.innerHTML = `<div class="acct">${h}</div>`;
  const on = (id, ev, fn) => { const el = box.querySelector(id); if (el) el.addEventListener(ev, fn); };
  on("#acLogin", "click", connectAccount);
  on("#acCancel", "click", async () => { await api("/account/cancel", { method: "POST" }); loadAccount(); });
  on("#acLogout", "click", async () => { await api("/account/logout", { method: "POST" }); wasLoggedIn = false; loadAccount(); refreshStatus(); toast("Compte déconnecté"); });
  on("#acCodeForm", "submit", async (e) => {
    e.preventDefault();
    try { await api("/account/code", { method: "POST", body: { code: $("#acCode").value } }); } catch (err) { toast(err.message); }
    loadAccount();
  });
}

/* ---------------- Compte Mora (connexion, mot de passe, comptes) ---------------- */
let me = null;
async function loadMe() {
  try { me = await api("/auth/me"); } catch { me = null; }
  renderMe();
  if (me?.user?.admin) loadUsers(); else $("#usersSection").hidden = true;
}
function renderMe() {
  const box = $("#meBlock");
  if (!me?.enabled || !me.user) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="state"><span class="dot ok"></span>Connecté·e en tant que <b>${esc(me.user.username)}</b>${me.user.admin ? ` <span class="tag">admin</span>` : ""}</div>
    <div class="row2"><button class="btn ghost" id="meLogout" type="button">Se déconnecter</button><button class="btn ghost" id="mePwBtn" type="button">Changer le mot de passe</button></div>
    <form class="pwform" id="mePw" hidden>
      <input name="current" type="password" autocomplete="current-password" placeholder="Mot de passe actuel" required>
      <input name="password" type="password" autocomplete="new-password" placeholder="Nouveau mot de passe (10 caractères min.)" required minlength="10">
      <input name="password2" type="password" autocomplete="new-password" placeholder="Confirme le nouveau mot de passe" required minlength="10">
      <div class="row2"><button class="btn" type="submit">Enregistrer</button></div>
      <p class="small">Tes autres appareils seront déconnectés.</p>
    </form>
    ${me.sessions > 1 ? `<p class="small">Connecté·e sur ${me.sessions} appareils. <button class="linkbtn" id="meLogoutAll" type="button">Déconnecter partout</button></p>` : ""}`;
  const logout = async (everywhere) => { try { await api("/auth/logout", { method: "POST", body: { everywhere } }); } catch {} location.replace("/login"); };
  box.querySelector("#meLogout").onclick = () => logout(false);
  const all = box.querySelector("#meLogoutAll"); if (all) all.onclick = () => logout(true);
  box.querySelector("#mePwBtn").onclick = () => { const f = box.querySelector("#mePw"); f.hidden = !f.hidden; if (!f.hidden) f.current.focus(); };
  box.querySelector("#mePw").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.password.value !== f.password2.value) return toast("Les deux mots de passe ne sont pas identiques.");
    try { await api("/auth/password", { method: "POST", body: { current: f.current.value, password: f.password.value } }); toast("Mot de passe changé"); loadMe(); }
    catch (err) { toast(err.message); }
  };
}

let users = [];
async function loadUsers() {
  try { users = await api("/users"); } catch { return; }
  $("#usersSection").hidden = false;
  renderUsers();
}
function renderUsers() {
  const box = $("#usersBlock");
  box.innerHTML = `<div class="users">${users.map((u) => `<div class="user">
      <span class="who"><b>${esc(u.username)}</b><span class="small">${u.admin ? "administrateur · " : ""}créé le ${new Date(u.createdAt).toLocaleDateString("fr-FR")}</span></span>
      <span class="uacts"><button class="btn ghost" data-pw="${esc(u.id)}" type="button">Mot de passe</button>${u.id === me.user.id ? "" : `<button class="btn ghost" data-adm="${esc(u.id)}" type="button">${u.admin ? "Retirer admin" : "Admin"}</button><button class="btn danger" data-del="${esc(u.id)}" type="button">Supprimer</button>`}</span>
    </div>`).join("")}</div>
    <form class="userform" id="userAdd">
      <b>Ajouter un compte</b>
      <input name="username" placeholder="Identifiant" autocomplete="off" autocapitalize="none" spellcheck="false" required minlength="2" maxlength="32">
      <input name="password" type="password" placeholder="Mot de passe provisoire (10 caractères min.)" autocomplete="new-password" required minlength="10">
      <label class="chk"><input type="checkbox" name="admin"> Administrateur (peut gérer les comptes)</label>
      <div class="row2"><button class="btn" type="submit">Créer le compte</button></div>
      <p class="small">Donne l’identifiant et le mot de passe à la personne : elle pourra le changer dans ses Réglages, puis connecter son propre compte Claude.</p>
    </form>`;
  const byId = (id) => users.find((u) => u.id === id);
  box.querySelectorAll("[data-pw]").forEach((b) => (b.onclick = async () => {
    const u = byId(b.dataset.pw);
    const pw = prompt(`Nouveau mot de passe pour ${u.username} (10 caractères minimum) :`);
    if (!pw) return;
    try { await api(`/users/${u.id}`, { method: "PATCH", body: { password: pw } }); toast("Mot de passe changé"); } catch (e) { toast(e.message); }
  }));
  box.querySelectorAll("[data-adm]").forEach((b) => (b.onclick = async () => {
    const u = byId(b.dataset.adm);
    try { await api(`/users/${u.id}`, { method: "PATCH", body: { admin: !u.admin } }); loadUsers(); } catch (e) { toast(e.message); }
  }));
  box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    const u = byId(b.dataset.del);
    if (!confirm(`Supprimer le compte « ${u.username} » ? Son fil, ses gardés et sa connexion Claude seront effacés.`)) return;
    try { await api(`/users/${u.id}`, { method: "DELETE" }); toast("Compte supprimé"); loadUsers(); } catch (e) { toast(e.message); }
  }));
  box.querySelector("#userAdd").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await api("/users", { method: "POST", body: { username: f.username.value, password: f.password.value, admin: f.admin.checked } }); toast("Compte créé"); loadUsers(); }
    catch (err) { toast(err.message); }
  };
}

/* ---------------- Démarrage ---------------- */
(async () => {
  try {
    const r = await api("/stream");
    state.stream = r.items; state.status = r;
    renderStream();
    await Promise.all([loadKept(), loadThemes(), loadAccount(), loadPrefs(), loadHidden(), loadQuests(), loadMe()]);
    checkSentinel();
    if (r.refreshing || r.translating || r.questing) { wasQuesting = !!r.questing; pollStatus(); }
  } catch (e) {
    $("#stream").innerHTML = `<div class="empty-stream">Impossible de joindre le serveur Mora. Vérifie qu’il tourne (<code>npm start</code>).</div>`;
  }
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
