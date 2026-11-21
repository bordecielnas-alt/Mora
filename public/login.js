// Écran de connexion (et création du compte administrateur au premier lancement).
const $ = (s) => document.querySelector(s);
async function post(path, body) {
  const res = await fetch("/api/auth/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
function wire(form, run) {
  const errBox = form.querySelector("[data-err]"), btn = form.querySelector("button[type=submit]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.hidden = true; btn.disabled = true;
    try { if ((await run(Object.fromEntries(new FormData(form)))) !== "wait") location.replace("/"); else btn.disabled = false; }
    catch (err) { errBox.textContent = err.message; errBox.hidden = false; btn.disabled = false; }
  });
}
// Connexion en deux temps si la double authentification est active : mot de passe, puis code.
wire($("#loginForm"), async (f) => {
  const form = $("#loginForm"), step2 = form.querySelector("[data-step='2']");
  const r = await post("login", { username: f.username, password: f.password, code: step2.hidden ? undefined : f.code });
  if (r.totp) {
    form.querySelector("[data-step='1']").hidden = true; step2.hidden = false;
    form.code.required = true; form.code.focus();
    return "wait";
  }
});
wire($("#setupForm"), (f) => {
  if (f.password !== f.password2) throw new Error("Les deux mots de passe ne sont pas identiques.");
  return post("setup", { code: f.code, username: f.username, password: f.password });
});
(async () => {
  let me = {};
  try { me = await (await fetch("/api/auth/me")).json(); } catch {}
  if (!me.enabled || me.loggedIn) return location.replace("/");
  const form = me.needsSetup ? $("#setupForm") : $("#loginForm");
  form.hidden = false;
  form.querySelector("input").focus();
})();
