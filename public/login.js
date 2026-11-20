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
    try { await run(Object.fromEntries(new FormData(form))); location.replace("/"); }
    catch (err) { errBox.textContent = err.message; errBox.hidden = false; btn.disabled = false; }
  });
}
wire($("#loginForm"), (f) => post("login", { username: f.username, password: f.password }));
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
