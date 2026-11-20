// Apprentissage silencieux : des poids par thème, format et source,
// ajustés à chaque « j'aime », « garder » ou « pas pour moi ».
import { OUTSIDE } from "./store.js";

const STEP = { theme: 0.18, type: 0.08, source: 0.12 };
const BOUNDS = { theme: [0.1, 2], type: [0.3, 1.7], source: [0.3, 1.8] };

const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));

export const LIKE_FACTOR = 0.6; // un « j'aime » compte un peu moins qu'un « garder »

export function learn(state, item, sign, factor = 1, kinds = ["theme", "type", "source"]) {
  const w = state.weights;
  const bump = (kind, key) => {
    if (!key || !kinds.includes(kind)) return;
    w[kind][key] = clamp((w[kind][key] ?? 1) + STEP[kind] * sign * factor, BOUNDS[kind]);
  };
  // Le thème n'apprend que pour tes thèmes (pas pour le sujet d'une recherche ponctuelle).
  if (state.themes.includes(item.theme) || item.theme === OUTSIDE) bump("theme", item.theme);
  bump("type", item.type);
  bump("source", item.source);
}

// Raisons du « Pas pour moi » : chacune n'ajuste que ce qu'elle vise.
export const REASONS = {
  seen: { label: "déjà vu", kinds: [] },
  long: { label: "trop long", kinds: [], counter: "tooLong" },
  source: { label: "source bof", kinds: ["source"], factor: 1.5 },
  topic: { label: "sujet hors cible", kinds: ["theme"] },
  basic: { label: "trop basique", kinds: [], counter: "tooBasic" },
};

/** Effet d'un masquage (sign = -1 pour masquer, +1 pour annuler), selon sa raison éventuelle. */
export function tossEffect(state, item, sign) {
  const r = REASONS[item.reason];
  if (!r) return learn(state, item, sign);
  if (r.kinds.length) learn(state, item, sign, r.factor || 1, r.kinds);
  if (r.counter) state.feedback[r.counter] = Math.max(0, (state.feedback[r.counter] || 0) - sign);
}

export function score(state, item, now = Date.now()) {
  const w = state.weights;
  const ageDays = (now - Date.parse(item.foundAt)) / 86400000;
  const fresh = Math.pow(0.85, Math.max(0, ageDays)); // une proposition perd ~15 % par jour
  const pinned = (state.prefs?.pinnedSources || []).some((p) => sourceMatch(item, p)) ? 1.4 : 1;
  return (w.theme[item.theme] ?? (item.theme === OUTSIDE ? 1 : 0.6)) * (w.type[item.type] ?? 1) * (w.source[item.source] ?? 1) * pinned * fresh;
}

const fold = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
/** Le contenu vient-il de cette source ? (nom ou domaine, sans tenir compte de la casse) */
export function sourceMatch(item, name) {
  const n = fold(name).replace(/^www\./, "").trim();
  if (!n) return false;
  let host = "";
  try { host = new URL(item.url).host.replace(/^www\./, ""); } catch {}
  return fold(item.source).includes(n) || fold(host).includes(n);
}
/** Le contenu contient-il un mot-clé interdit ? (titre, titre original, résumé) */
export function hasBlockedWord(item, words) {
  const text = fold([item.title, item.original_title, item.titleOriginal, item.excerpt].join(" "));
  return (words || []).some((w) => { const k = fold(w).trim(); return k && new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text); });
}
