// Stockage local : un seul fichier JSON (data/mora.json), écrit de façon atomique.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const TYPES = ["article", "video", "podcast", "lien"];
export const OUTSIDE = "Hors bulle"; // thème des contenus choisis hors de tes centres d'intérêt

// Réglages de recherche et d'apparence (onglet Réglages).
export const DEFAULT_PREFS = () => ({
  lang: "fr",                 // langue d'origine préférée des contenus
  nativeShare: 90,            // % de contenus écrits dans cette langue, le reste en anglais
  mix: { article: 50, video: 30, podcast: 20 }, // poids relatifs des formats recherchés
  bubble: 10,                 // % de contenus « hors bulle »
  blockedWords: [],           // mots-clés à ne jamais proposer
  blockedSources: [],         // sources à ne jamais proposer
  pinnedSources: [],          // sources à suivre en priorité
  autoplay: true,             // lecture auto (en muet) des vidéos YouTube / Vimeo dans le fil
  mode: "auto",               // clair / sombre : auto | light | dark (attribut data-theme)
  palette: "lagune",          // palette de couleurs (attribut data-palette, voir public/themes.css)
});

const DEFAULT_STATE = () => ({
  version: 1,
  themes: [],                 // noms des thèmes suivis
  weights: { theme: {}, type: { article: 1, video: 1, podcast: 1, lien: 1 }, source: {} },
  items: [],                  // propositions et contenus gardés
  decisions: 0,
  lastRefresh: null,
  lastError: null,
  prefs: DEFAULT_PREFS(),
  feedback: { tooLong: 0, tooBasic: 0 }, // raisons de masquage qui ne visent ni thème, ni format, ni source
  suggestions: [],            // thèmes suggérés par l'IA : { name, why, at }
  dismissedSuggestions: [],   // suggestions refusées (pas reproposées)
  quests: [],                 // recherches ponctuelles : { id, q, at, status, error }
});

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "mora.json");
    fs.mkdirSync(dir, { recursive: true });
    // Ancien nom de l'app : reprend data/tamis.json s'il existe encore.
    const old = path.join(dir, "tamis.json");
    if (!fs.existsSync(this.file) && fs.existsSync(old)) fs.renameSync(old, this.file);
    this.state = this.#load();
    this.timer = null;
  }

  #load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const d = DEFAULT_STATE();
      const prefs = { ...d.prefs, ...s.prefs, mix: { ...d.prefs.mix, ...s.prefs?.mix } };
      return { ...d, ...s, weights: { ...d.weights, ...s.weights }, prefs, feedback: { ...d.feedback, ...s.feedback } };
    } catch (e) {
      if (e.code !== "ENOENT") {
        const bak = this.file + ".corrompu-" + Date.now();
        try { fs.copyFileSync(this.file, bak); } catch {}
        console.error(`Fichier de données illisible, copie gardée dans ${bak}`);
      }
      return DEFAULT_STATE();
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this.timer);
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get(id) { return this.state.items.find((i) => i.id === id); }

  hasUrl(url) {
    const n = normUrl(url);
    return this.state.items.some((i) => normUrl(i.url) === n);
  }

  addItem(raw) {
    const item = {
      id: crypto.randomUUID(),
      url: raw.url,
      title: raw.title,
      titleOriginal: raw.original_title && raw.original_title !== raw.title ? raw.original_title : "",
      titleFr: true,          // titre déjà en français (les anciens contenus sont traduits au démarrage)
      source: raw.source || hostOf(raw.url),
      type: TYPES.includes(raw.type) ? raw.type : "lien",
      theme: raw.theme,
      language: String(raw.language || "").toLowerCase().slice(0, 5), // langue d'origine (fr, en…)
      duration: raw.duration || "",
      excerpt: raw.excerpt || "",
      why: raw.why || "",
      image: raw.image || null,
      demo: !!raw.demo,
      foundAt: new Date().toISOString(),
      status: raw.quest ? "quest" : "new", // new → shown → keep | toss ; keep → removed ; quest = recherche ponctuelle
      quest: raw.quest || null,
      reason: null,           // raison facultative du « Pas pour moi »
      shownAt: null,
      decidedAt: null,
      note: "",
      star: false,
      liked: false,           // « J'aime » : signal de goût, sans ranger dans les gardés
      likedAt: null,
    };
    this.state.items.push(item);
    return item;
  }
}

export function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/.test(k)) x.searchParams.delete(k);
    return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/$/, "") + x.search).toLowerCase();
  } catch { return String(u).toLowerCase(); }
}

export function hostOf(u) {
  try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; }
}

/** Durée en minutes à partir du champ duration (« 8 min », « 12:30 », « 1:02:00 », « 1 h 20 »). null si inconnue. */
export function durationMin(d) {
  const s = String(d || "").toLowerCase().trim();
  let m;
  if ((m = s.match(/^(\d+):(\d{1,2}):(\d{2})$/))) return +m[1] * 60 + +m[2] + +m[3] / 60;
  if ((m = s.match(/^(\d+):(\d{2})$/))) return +m[1] + +m[2] / 60;
  if ((m = s.match(/(\d+)\s*h(?:eures?)?\s*(\d+)?/))) return +m[1] * 60 + (+m[2] || 0);
  if ((m = s.match(/(\d+)\s*(?:min|mn|minutes?)/))) return +m[1];
  if ((m = s.match(/^(\d+)$/))) return +m[1];
  return null;
}
