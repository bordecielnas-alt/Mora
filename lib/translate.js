// Traduction en français des titres déjà enregistrés (contenus trouvés avant que Mora
// demande des titres en français). Une seule requête par lot, sans recherche web.
import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./discover.js";
import { spawnClaude } from "./account.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["titles"],
  properties: {
    titles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title"],
        properties: {
          id: { type: "string" },
          title: { type: "string", description: "The title in natural French (unchanged if it is already French)." },
        },
      },
    },
  },
};

function prompt(items) {
  const list = items.map((i) => ({ id: i.id, title: i.title, source: i.source }));
  return `Translate these content titles into natural, idiomatic French, as a French magazine would title them. Keep proper names, brand, show and album names as they are. If a title is already in French, return it unchanged. Return one entry per id.

${JSON.stringify(list, null, 1)}`;
}

async function viaCli(items) {
  const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA)];
  if (process.env.MORA_CLAUDE_MODEL) args.push("--model", process.env.MORA_CLAUDE_MODEL);
  const out = await new Promise((resolve, reject) => {
    const child = spawnClaude(args, { cwd: os.tmpdir() });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Claude Code n'a pas répondu en 5 minutes.")); }, 5 * 60e3);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) reject(new Error(`Claude Code s'est arrêté (code ${code}). ${stderr.trim().slice(0, 200)}`));
      else resolve(stdout);
    });
    child.stdin.end(prompt(items));
  });
  const res = JSON.parse(out);
  if (res.is_error) throw new Error(String(res.result || "erreur").slice(0, 200));
  let data = res.structured_output;
  if (!data && typeof res.result === "string") {
    const m = res.result.match(/\{[\s\S]*\}/);
    if (m) data = JSON.parse(m[0]);
  }
  return data?.titles || [];
}

async function viaApi(items) {
  const msg = await new Anthropic().messages.create({
    model: MODEL,
    max_tokens: 8000,
    tools: [{ name: "titres", description: "Return the translated titles.", strict: true, input_schema: SCHEMA }],
    tool_choice: { type: "tool", name: "titres" },
    messages: [{ role: "user", content: prompt(items) }],
  });
  const call = msg.content.find((b) => b.type === "tool_use");
  return call?.input?.titles || [];
}

/** Traduit les titres des contenus qui n'ont pas encore été traités. Renvoie le nombre de titres traduits. */
export async function translateTitles(items, backend) {
  const todo = items.filter((i) => !i.titleFr && !i.demo && i.status !== "removed");
  let changed = 0;
  for (let k = 0; k < todo.length; k += 30) {
    const batch = todo.slice(k, k + 30);
    const out = backend === "api" ? await viaApi(batch) : await viaCli(batch);
    const byId = new Map(out.map((t) => [t.id, String(t.title || "").trim()]));
    for (const it of batch) {
      const fr = byId.get(it.id);
      if (!fr) continue;
      if (fr !== it.title) { it.titleOriginal = it.title; it.title = fr; changed++; }
      it.titleFr = true;
    }
  }
  return changed;
}
