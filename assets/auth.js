// pages publiques + login.html (version session serveur uniquement)

const LOGIN_ENDPOINT = "/api/site/login";

// Prefix pour servir le site depuis un sous-chemin
function getPrefix() {
  return (window.__SITE_PREFIX__ !== undefined) ? String(window.__SITE_PREFIX__) : "";
}

// Lit le param redirect en securise
function getRedirectTarget() {
  const qs = new URLSearchParams(window.location.search || "");
  const r = qs.get("redirect");
  if (!r) return null;
  if (/^https?:\/\//i.test(r)) return null;
  if (r.startsWith("//")) return null;
  if (!r.startsWith("/")) return null;
  if (r.includes("\0")) return null;
  return r;
}

// Redirection apres login
function goAfterLogin() {
  const prefix = getPrefix();
  const target = getRedirectTarget();
  if (target) {
    window.location.href = target;
  } else {
    window.location.href = prefix + "index.html";
  }
}

// Redirige vers login si pas connecte (session serveur)
async function requireAuth() {
  const prefix = getPrefix();
  const dest = window.location.pathname + window.location.search + window.location.hash;

  try {
    const res = await fetch("/api/site/session", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (res.ok) return; // session OK => on reste sur la page
  } catch {}

  // pas de session => redirect login
  window.location.replace(prefix + "login.html?redirect=" + encodeURIComponent(dest));
}

// Verifie le mot de passe via l'API
async function loginWith(pwd) {
  try {
    const res = await fetch(LOGIN_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: String(pwd || "") }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Deconnexion simple
function logout() {
  fetch("/api/site/logout", {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => {}).finally(() => {
    window.location.href = getPrefix() + "login.html";
  });
}

// Branche un formulaire de login
function wireLoginForm(options = {}) {
  const {
    formId = "loginForm",
    usernameId = "username",
    passwordId = "password",
    errorId = "loginError",
    forceUsername = "durand",
  } = options;

  const form = document.getElementById(formId);
  if (!form) return;

  const pass = document.getElementById(passwordId);
  const user = document.getElementById(usernameId);
  const err  = document.getElementById(errorId);

  form.setAttribute("autocomplete", "on");

  if (!user) {
    const hiddenUser = document.createElement("input");
    hiddenUser.type = "text";
    hiddenUser.name = "username";
    hiddenUser.autocomplete = "username";
    hiddenUser.value = String(forceUsername || "user");
    hiddenUser.style.position = "absolute";
    hiddenUser.style.left = "-9999px";
    hiddenUser.style.width = "1px";
    hiddenUser.style.height = "1px";
    hiddenUser.tabIndex = -1;
    form.prepend(hiddenUser);
  } else {
    user.name = user.name || "username";
    user.autocomplete = "username";
    if (!user.value) user.value = String(forceUsername || "");
  }

  if (pass) {
    pass.name = pass.name || "password";
    pass.type = "password";
    pass.autocomplete = "current-password";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (err) err.textContent = "";

    const pwd = pass ? String(pass.value || "") : "";
    const ok = await loginWith(pwd);

    if (ok) {
      goAfterLogin();
    } else {
      if (err) err.textContent = "Mot de passe incorrect.";
      if (pass) pass.focus();
    }
  });
}

// Expose les fonctions globalement
window.requireAuth = requireAuth;
window.loginWith = loginWith;
window.logout = logout;
window.wireLoginForm = wireLoginForm;
