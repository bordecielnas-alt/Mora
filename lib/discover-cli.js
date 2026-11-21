// Recherche de contenus via Claude Code (la commande `claude`), connecté à ton abonnement Claude.
// Pas de clé API : la recherche compte dans les limites d'usage de ton abonnement.
import os from "node:os";
import { buildPrompt, buildQuestPrompt, itemsSchema, allowedThemes, SYSTEM } from "./discover.js";
import { spawnClaude } from "./account.js";
import { fromCli } from "./usage.js";

/** Même contrat que discover() : renvoie { items, suggestions, usage }. quest = { q, label } pour une recherche ponctuelle. */
export async function discoverWithCli(state, { count = 12, log = console.log, quest = null } = {}) {
  const themes = quest ? [quest.label] : allowedThemes(state);
  if (!quest && !state.themes.length) return { items: [], suggestions: [] };
  const suggest = !quest;
  const finish = "When you are done, return the whole list as your final structured output.";
  const prompt = quest ? buildQuestPrompt(state, quest.q, quest.label, count, finish) : buildPrompt(state, count, finish, suggest);
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(itemsSchema(themes, { suggest })),
    // Recherche web seulement : pas de WebFetch (lire les pages coûte cher, Mora vérifie les liens lui-même).
    "--tools", "WebSearch",
    "--allowedTools", "WebSearch",
    // Consigne système courte à la place de celle de Claude Code, ni MCP ni commandes : moins de jetons relus à chaque tour.
    "--system-prompt", SYSTEM,
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--effort", process.env.MORA_CLAUDE_EFFORT || "medium",
  ];
  if (process.env.MORA_CLAUDE_MODEL) args.push("--model", process.env.MORA_CLAUDE_MODEL);

  const out = await new Promise((resolve, reject) => {
    const child = spawnClaude(args, { cwd: os.tmpdir() }); // hors du projet, pour ne charger aucun CLAUDE.md
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Claude Code n'a pas répondu en 10 minutes.")); }, 10 * 60e3);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`Impossible de lancer Claude Code : ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) reject(new Error(`Claude Code s'est arrêté (code ${code}). ${stderr.trim().slice(0, 300)}`));
      else resolve(stdout);
    });
    child.stdin.end(prompt);
  });

  let res;
  try { res = JSON.parse(out); } catch { throw new Error("Réponse de Claude Code illisible."); }
  if (res.is_error) {
    const msg = String(res.result || res.subtype || "erreur");
    if (/log ?in|auth|credential/i.test(msg)) throw new Error("Claude Code n'est pas connecté. Connecte ton compte dans l’onglet Réglages.");
    throw Object.assign(new Error(`Claude Code : ${msg.slice(0, 300)}`), { usage: fromCli(res) });
  }
  let data = res.structured_output;
  if (!data && typeof res.result === "string") {
    const m = res.result.match(/\{[\s\S]*\}/);
    if (m) { try { data = JSON.parse(m[0]); } catch {} }
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  const usage = fromCli(res);
  log(`Claude Code : ${items.length} propositions reçues${usage.searches ? ` après ${usage.searches} recherches web` : ""} (${usage.input + usage.cacheRead + usage.cacheWrite + usage.output} jetons).`);
  return { items: items.filter((i) => /^https?:\/\//.test(i.url) && i.title && themes.includes(i.theme)), suggestions: data?.suggested_themes || [], usage };
}
