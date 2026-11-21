// Consommation de jetons (tokens) de chaque appel à Claude : recherches du fil, recherches
// ponctuelles, traduction des titres. Gardée par compte dans mora.json (state.usage).

const KEEP = 1000; // nombre d'appels gardés dans l'historique

// Tarifs publics de l'API, en dollars par million de jetons (entrée, sortie).
// Écriture en cache = 1,25 × l'entrée ; lecture en cache = 0,05 × l'entrée (0,1 × pour les anciens modèles).
const PRICES = [
  [/fable-5-2|mythos-5-2/, 8, 40, 0.025],
  [/fable|mythos/, 10, 50, 0.1],
  [/opus-5-5/, 4, 20, 0.05],
  [/opus/, 5, 25, 0.1],
  [/sonnet-5/, 2, 10, 0.05],
  [/sonnet/, 3, 15, 0.1],
  [/haiku-5/, 0.1, 0.5, 0.1],
  [/haiku/, 1, 5, 0.1],
];
const SEARCH_PRICE = 10 / 1000; // 10 $ les 1 000 recherches web

export function estimateCost(model, u) {
  const [, pin, pout, readF] = PRICES.find(([re]) => re.test(model || "")) || PRICES[2];
  return ((u.input || 0) * pin + (u.cacheWrite || 0) * pin * 1.25 + (u.cacheRead || 0) * pin * readF + (u.output || 0) * pout) / 1e6
    + (u.searches || 0) * SEARCH_PRICE;
}

/** Additionne l'objet usage d'une réponse de l'API (un tour) dans acc. */
export function addApiUsage(acc, msg) {
  const u = msg?.usage || {};
  acc.input += u.input_tokens || 0;
  acc.output += u.output_tokens || 0;
  acc.cacheRead += u.cache_read_input_tokens || 0;
  acc.cacheWrite += u.cache_creation_input_tokens || 0;
  acc.searches += u.server_tool_use?.web_search_requests || 0;
  if (msg?.model) acc.model = msg.model;
  return acc;
}
export const emptyUsage = (model = "") => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0, model, cost: null });

/** Lit la consommation d'une réponse JSON de Claude Code (`claude -p --output-format json`). */
export function fromCli(res) {
  const acc = emptyUsage();
  const per = Object.entries(res?.modelUsage || {});
  if (per.length) {
    let best = -1;
    for (const [model, m] of per) {
      acc.input += m.inputTokens || 0;
      acc.output += m.outputTokens || 0;
      acc.cacheRead += m.cacheReadInputTokens || 0;
      acc.cacheWrite += m.cacheCreationInputTokens || 0;
      acc.searches += m.webSearchRequests || 0;
      const w = m.costUSD ?? m.outputTokens ?? 0;
      if (w > best) { best = w; acc.model = model; }
    }
  } else {
    const u = res?.usage || {};
    acc.input = u.input_tokens || 0;
    acc.output = u.output_tokens || 0;
    acc.cacheRead = u.cache_read_input_tokens || 0;
    acc.cacheWrite = u.cache_creation_input_tokens || 0;
  }
  if (!acc.searches) acc.searches = res?.usage?.server_tool_use?.web_search_requests || 0;
  if (typeof res?.total_cost_usd === "number") acc.cost = res.total_cost_usd; // calculé par Claude Code
  if (res?.duration_ms) acc.ms = res.duration_ms;
  return acc;
}

const total = (e) => (e.input || 0) + (e.output || 0) + (e.cacheRead || 0) + (e.cacheWrite || 0);

/** Ajoute un appel à l'historique du compte. kind : fil | ponctuelle | traduction. */
export function recordUsage(state, usage, { kind, label = "", added = null, ms = null, backend = "" } = {}) {
  if (!usage) return null;
  const entry = {
    at: new Date().toISOString(), kind, label: String(label).slice(0, 80), backend,
    model: usage.model || "", input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
    searches: usage.searches, added, ms: usage.ms || ms || null,
  };
  entry.tokens = total(entry);
  entry.estimated = usage.cost == null;
  entry.cost = Math.round((usage.cost ?? estimateCost(entry.model, entry)) * 1e5) / 1e5;
  if (!entry.tokens && !entry.cost) return null;
  (state.usage ||= []).push(entry);
  if (state.usage.length > KEEP) state.usage = state.usage.slice(-KEEP);
  return entry;
}

/** Résumé pour l'onglet Stats : totaux par période, une barre par jour (30 jours), derniers appels. */
export function usageSummary(state) {
  const all = state.usage || [];
  const now = Date.now();
  const since = (days) => all.filter((e) => now - Date.parse(e.at) < days * 86400e3);
  const sum = (list) => {
    const s = { calls: list.length, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0, cost: 0, added: 0 };
    for (const e of list) for (const k of Object.keys(s)) if (k !== "calls") s[k] += e[k] || 0;
    s.cost = Math.round(s.cost * 1e4) / 1e4;
    return s;
  };
  // Jour local du serveur (règle TZ dans Docker), pas UTC.
  const day = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
  const dayOf = (e) => day(new Date(e.at));
  const days = [];
  for (let k = 29; k >= 0; k--) {
    const d = day(new Date(now - k * 86400e3));
    const its = all.filter((e) => dayOf(e) === d);
    const byKind = {};
    for (const e of its) byKind[e.kind] = (byKind[e.kind] || 0) + e.tokens;
    days.push({ day: d, tokens: its.reduce((a, e) => a + e.tokens, 0), cost: its.reduce((a, e) => a + (e.cost || 0), 0), calls: its.length, byKind });
  }
  const byKind = {};
  for (const e of since(30)) { const b = (byKind[e.kind] ||= { calls: 0, tokens: 0, cost: 0, added: 0 }); b.calls++; b.tokens += e.tokens; b.cost += e.cost || 0; b.added += e.added || 0; }
  return {
    today: sum(all.filter((e) => dayOf(e) === day(new Date(now)))),
    week: sum(since(7)), month: sum(since(30)), all: sum(all),
    since: all[0]?.at || null, days, byKind,
    recent: all.slice(-20).reverse(),
  };
}
