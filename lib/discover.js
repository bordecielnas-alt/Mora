// Recherche de contenus sur le web avec Claude (outil de recherche web côté serveur),
// guidée par les thèmes, les poids appris et les derniers choix.
import Anthropic from "@anthropic-ai/sdk";
import { TYPES, OUTSIDE, DEFAULT_PREFS } from "./store.js";
import { REASONS } from "./learn.js";

export const MODEL = process.env.MORA_MODEL || "claude-opus-5-5";

let client = null;
function getClient() {
  if (!client) client = new Anthropic(); // ANTHROPIC_API_KEY, ou un profil `ant auth login`
  return client;
}

export function hasCredentials() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

// Langues proposées dans Réglages (code → nom en anglais pour le prompt).
export const LANGS = { fr: "French", en: "English", es: "Spanish", de: "German", it: "Italian", pt: "Portuguese" };

/** Thèmes que l'IA peut attribuer : ceux de l'utilisateur, plus « Hors bulle » si le taux est au-dessus de 0. */
export const allowedThemes = (state) => ((state.prefs?.bubble ?? 0) > 0 ? [...state.themes, OUTSIDE] : state.themes);

export function itemsSchema(themes, { suggest = false } = {}) {
  const extra = suggest ? {
    suggested_themes: {
      type: "array",
      description: "0 to 2 new themes worth following, only if a recurring sub-topic shows up in at least 3 of their kept or liked items and isn't covered by an existing theme. Usually empty.",
      items: {
        type: "object", additionalProperties: false, required: ["name", "why"],
        properties: {
          name: { type: "string", description: "Short theme name in French, 1 to 3 words, e.g. 'Urbanisme'." },
          why: { type: "string", description: "In French, max 15 words: which kept items it groups." },
        },
      },
    },
  } : {};
  return {
      type: "object",
      additionalProperties: false,
      required: suggest ? ["items", "suggested_themes"] : ["items"],
      properties: {
        ...extra,
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["url", "title", "original_title", "language", "source", "type", "theme", "duration", "excerpt", "why"],
            properties: {
              url: { type: "string", description: "Direct URL of the content itself (not a search page)." },
              title: { type: "string", description: "Title of the content in French. If the original is not in French, translate it into natural French (keep proper names)." },
              original_title: { type: "string", description: "Title exactly as published, in its original language (same as title if already French)." },
              language: { type: "string", description: "ISO 639-1 code of the language the content was originally written or recorded in, e.g. 'fr', 'en'." },
              source: { type: "string", description: "Publication, channel or show name, e.g. 'Le Monde', 'YouTube · Fireship'." },
              type: { type: "string", enum: TYPES },
              theme: { type: "string", enum: themes },
              duration: { type: "string", description: "Reading time ('8 min'), video length ('12:30'), episode length ('45 min'), or '' if unknown." },
              excerpt: { type: "string", description: "One or two sentences in French saying what the reader will get from it." },
              why: { type: "string", description: "Short reason in French (max 12 words) why it fits this user, based on their choices." },
            },
          },
        },
      },
  };
}

function proposeTool(themes, opts) {
  return {
    name: "propose_items",
    description: "Submit the final list of content proposals for the user's feed. Call this exactly once, after searching.",
    strict: true,
    input_schema: itemsSchema(themes, opts),
  };
}

export function buildPrompt(state, count, finish = "When you are done, call propose_items once with the whole list.", suggest = false) {
  const w = state.weights;
  const themes = state.themes.map((t) => `- ${t} (intérêt ${(w.theme[t] ?? 1).toFixed(2)})`).join("\n");
  const types = Object.entries(w.type).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ");
  const line = (i) => `- [${i.theme}/${i.type}${i.duration ? "/" + i.duration : ""}] ${i.titleOriginal || i.title} (${i.source})${i.note ? ` — note: ${i.note}` : ""}${i.status === "toss" && REASONS[i.reason] ? ` — dismissed because: ${REASON_EN[i.reason]}` : ""}`;
  const recent = (status) =>
    state.items
      .filter((i) => i.status === status && !i.demo)
      .sort((a, b) => (b.decidedAt || "").localeCompare(a.decidedAt || ""))
      .slice(0, 15)
      .map(line)
      .join("\n") || "(rien encore)";
  const liked = state.items
    .filter((i) => i.liked && i.status !== "toss" && !i.demo)
    .sort((a, b) => (b.likedAt || "").localeCompare(a.likedAt || ""))
    .slice(0, 15)
    .map(line)
    .join("\n") || "(rien encore)";
  const likedSources = Object.entries(w.source).filter(([, v]) => v >= 1.2).map(([k]) => k).join(", ") || "(pas encore)";
  const avoidSources = Object.entries(w.source).filter(([, v]) => v <= 0.7).map(([k]) => k).join(", ") || "(aucune)";
  const p = { ...DEFAULT_PREFS(), ...state.prefs };
  const n = (pct) => Math.round((count * pct) / 100);

  // Langue d'origine : X % dans la langue choisie, le reste en anglais.
  const lang = LANGS[p.lang] || "French";
  const native = n(p.nativeShare);
  const langRule = p.lang === "en" || p.nativeShare >= 100
    ? `- Only pick content originally written or recorded in ${lang}${p.lang === "en" ? "" : " (by " + lang + "-language publications, not translations or dubbed versions)"}.`
    : `- Language: about ${p.nativeShare}% of the items (${native} of ${count}) must be content originally written or recorded in ${lang}, by ${lang}-language publications or creators (not translations, dubs or subtitles of foreign content). The other ${count - native} must be originally in English. No other languages.`;

  // Formats : poids relatifs article / vidéo / podcast.
  const mixTotal = Object.values(p.mix).reduce((a, b) => a + b, 0) || 1;
  const pct = (k) => Math.round(((p.mix[k] || 0) / mixTotal) * 100);
  const mixRule = `- Formats: aim for about ${pct("article")}% articles, ${pct("video")}% videos and ${pct("podcast")}% podcast episodes${["article", "video", "podcast"].filter((k) => !p.mix[k]).map((k) => ` (no ${k}s at all)`).join("")}. An occasional other useful link (type "lien") counts as an article. Use the format preference weights only to break ties.`;

  // Taux « sortir de ma bulle ».
  const outside = p.bubble > 0 ? Math.max(1, n(p.bubble)) : 0;
  const bubbleRule = outside
    ? `- Out of the bubble: ${outside} of the ${count} items must be outside all of their themes: excellent, surprising pieces on subjects they don't follow at all (pick varied fields, not adjacent to their themes). Give those the theme "${OUTSIDE}", and say in "why" what new ground it opens. Split the other ${count - outside} items across their themes.`
    : "";

  // Règles fixées à la main dans Réglages, et raisons de masquage récurrentes.
  const list = (a) => a.map((x) => `"${x}"`).join(", ");
  const rules = [
    p.blockedWords.length && `- Never propose anything about these topics or keywords: ${list(p.blockedWords)}.`,
    p.blockedSources.length && `- Never propose content from these sources or sites: ${list(p.blockedSources)}.`,
    p.pinnedSources.length && `- Favourite sources, chosen by hand: ${list(p.pinnedSources)}. Check what they recently published on the themes and include their best relevant pieces first.`,
    (state.feedback?.tooLong || 0) >= 2 && `- They have dismissed ${state.feedback.tooLong} items as too long: prefer shorter pieces (articles under 12 min, videos under 20 min) unless exceptional.`,
    (state.feedback?.tooBasic || 0) >= 2 && `- They have dismissed ${state.feedback.tooBasic} items as too basic: prefer in-depth, expert-level pieces over introductions.`,
  ].filter(Boolean).join("\n");

  return `You curate a private feed for one French-speaking person. Find ${count} fresh, high-quality pieces of web content (articles, videos, podcast episodes, or other useful links) for them.

Their themes, with learned interest weights (1 = neutral, higher = they keep more of it):
${themes}

Format preference weights: ${types}
Sources they tend to keep: ${likedSources}
Sources they tend to dismiss: ${avoidSources}

Recently kept (these show their taste — find more like these, but not duplicates):
${recent("keep")}

Recently liked (a strong signal of taste, like "kept"):
${liked}

Recently dismissed (avoid content like this):
${recent("toss")}

How to work:
- Use web search to find real, specific pieces of content. Prefer things published in the last few weeks, but an excellent evergreen piece is fine.
- Split the ${count - outside} ${outside ? "in-theme " : ""}items across their themes roughly in proportion to the interest weights, and give every theme at least one item.
${mixRule}
${langRule}
${bubbleRule ? bubbleRule + "\n" : ""}${rules ? rules + "\n" : ""}- Write every text field you return (title, excerpt, why) in French: translate titles of non-French content into natural French, and put the untranslated title in original_title. Set "language" to the original language of the content. Every URL must point to the content itself and must come from your search results; never invent a URL.
- Skip paywalled pages, listicles of links, and SEO filler.
${suggest ? "- Also look at their kept and liked items: if a recurring sub-topic (at least 3 items) isn't covered by their themes, suggest it in suggested_themes (max 2, French names). Otherwise leave it empty.\n" : ""}- ${finish}`;
}

const REASON_EN = { seen: "already seen", long: "too long", source: "bad source", topic: "off-topic", basic: "too basic" };

/** Prompt d'une recherche ponctuelle (« trouve-moi X cette semaine »), sans créer de thème. */
export function buildQuestPrompt(state, q, label, count, finish = "When you are done, call propose_items once with the whole list.") {
  const p = { ...DEFAULT_PREFS(), ...state.prefs };
  const lang = LANGS[p.lang] || "French";
  const list = (a) => a.map((x) => `"${x}"`).join(", ");
  return `You help one French-speaking person with a one-off request. Today is ${new Date().toISOString().slice(0, 10)}. Their request, in their own words: «${q}»

Find ${count} real, specific, high-quality pieces of web content (articles, videos, podcast episodes) that answer it. If the request mentions a period ("this week", "cette semaine", "aujourd'hui"), only pick content published in that period.

- Use web search. Every URL must point to the content itself and must come from your search results; never invent a URL.
- Prefer content originally in ${lang}${p.lang === "en" ? "" : ", with English as a fallback"}. Mix formats when it makes sense.
${p.blockedSources.length ? `- Never use these sources: ${list(p.blockedSources)}.\n` : ""}${p.blockedWords.length ? `- Avoid these topics unless the request is about them: ${list(p.blockedWords)}.\n` : ""}- Set theme to "${label}" for every item.
- Write title, excerpt and why in French (translate titles, keep the original in original_title). Set "language" to the original language.
- Skip paywalled pages, listicles of links, and SEO filler.
- ${finish}`;
}

/** Cherche de nouvelles propositions. Renvoie { items, suggestions }.
 *  Pour une recherche ponctuelle : quest = { q, label }. */
export async function discover(state, { count = 12, log = console.log, quest = null } = {}) {
  const themes = quest ? [quest.label] : allowedThemes(state);
  if (!quest && !state.themes.length) return { items: [], suggestions: [] };
  const suggest = !quest;
  const anthropic = getClient();
  const tools = [
    { type: "web_search_20260209", name: "web_search", max_uses: 12 },
    proposeTool(themes, { suggest }),
  ];
  const prompt = quest ? buildQuestPrompt(state, quest.q, quest.label, count) : buildPrompt(state, count, undefined, suggest);
  const messages = [{ role: "user", content: prompt }];

  for (let turn = 0; turn < 6; turn++) {
    const stream = anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // si la requête est refusée, l'API relance sur un modèle de repli
      output_config: { effort: "medium" },
      tools,
      tool_choice: { type: "auto" },
      messages,
    });
    const msg = await stream.finalMessage();

    if (msg.stop_reason === "refusal") throw new Error("La recherche a été refusée par le modèle.");

    const call = msg.content.find((b) => b.type === "tool_use" && b.name === "propose_items");
    if (call) {
      const input = typeof call.input === "string" ? JSON.parse(call.input) : call.input;
      const items = Array.isArray(input?.items) ? input.items : [];
      log(`IA : ${items.length} propositions reçues (${msg.usage?.output_tokens ?? "?"} jetons en sortie).`);
      return { items: items.filter((i) => /^https?:\/\//.test(i.url) && i.title && themes.includes(i.theme)), suggestions: input?.suggested_themes || [] };
    }

    messages.push({ role: "assistant", content: msg.content });
    if (msg.stop_reason === "pause_turn") continue; // la recherche web continue côté serveur
    if (msg.stop_reason === "max_tokens") throw new Error("Réponse coupée (max_tokens).");
    // Fin de tour sans appel à propose_items : on le redemande une fois.
    messages.push({ role: "user", content: "Call propose_items now with the items you found." });
  }
  throw new Error("Pas de liste de propositions après plusieurs tours.");
}

const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 Mora" };
const PAYWALL_URL = /\/(login|signin|sign-in|connexion|subscribe|subscription|abonnement|abonnez-vous|paywall)([/?#]|$)/i;

/** Vérifie qu'une page répond (pas de 404, pas de paywall évident) et récupère son image d'aperçu.
 *  Renvoie { ok, image, reason }. Un site qui bloque les robots (401, 403, 429) ou trop lent est gardé : on ne sait pas. */
export async function checkPage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "follow", headers: UA });
    if ([404, 410].includes(res.status) || res.status >= 500) return { ok: false, reason: `page introuvable (${res.status})` };
    if (PAYWALL_URL.test(new URL(res.url).pathname) && !PAYWALL_URL.test(new URL(url).pathname)) return { ok: false, reason: "redirigé vers une page d'abonnement" };
    if (!res.ok || !(res.headers.get("content-type") || "").includes("html")) return { ok: true, image: null };
    const html = (await res.text()).slice(0, 400000);
    if (/"isAccessibleForFree"\s*:\s*"?false/i.test(html)) return { ok: false, reason: "réservé aux abonnés" };
    return { ok: true, image: previewImage(html, res.url) };
  } catch (e) {
    const code = e?.cause?.code || e?.code;
    if (["ENOTFOUND", "ERR_INVALID_URL"].includes(code)) return { ok: false, reason: "site injoignable" };
    return { ok: true, image: null }; // délai dépassé ou autre : dans le doute, on garde
  }
}

function previewImage(html, base) {
  const m =
    html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
    html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  try { return m ? new URL(m[1].replace(/&amp;/g, "&"), base).href : null; } catch { return null; }
}

/** Récupère l'image d'aperçu (og:image) d'une page, sans bloquer si ça échoue. */
export async function fetchPreviewImage(url) {
  return (await checkPage(url)).image || null;
}
