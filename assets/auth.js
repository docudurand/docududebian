// pages publiques + login.html

const AUTH_KEY = "dd_auth_ok_v1";
const AUTH_TS_KEY = "dd_auth_ts_v1";

// Durée de "souvenir" côté navigateur (30 jours)
const AUTH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Ne pas ping le serveur à chaque page (1 fois / 10 minutes)
const SESSION_CHECK_EVERY_MS = 10 * 60 * 1000;
const LAST_CHECK_KEY = "dd_auth_last_check_v1";

// Nom d'utilisateur fixe (pour l'autofill)
const SITE_USERNAME = "durand";

// verification mot de passe
const LOGIN_ENDPOINT = "/api/site/login";

function getPrefix() {
  return (window.__SITE_PREFIX__ !== undefined) ? String(window.__SITE_PREFIX__) : "";
}

function nowMs() {
  return Date.now();
}

// --- Persistant (localStorage) ---
function isAuthed() {
  try {
    const ok = localStorage.getItem(AUTH_KEY) === "1";
    if (!ok) return false;

    const ts = Number(localStorage.getItem(AUTH_TS_KEY) || "0");
    if (!Number.isFinite(ts) || ts <= 0) return false;

    // expiré ?
    if (nowMs() - ts > AUTH_TTL_MS) {
      clearAuthed();
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function setAuthed() {
  try {
    localStorage.setItem(AUTH_KEY, "1");
    localStorage.setItem(AUTH_TS_KEY, String(nowMs()));
  } catch {}
}

function clearAuthed() {
  try {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(AUTH_TS_KEY);
    localStorage.removeItem(LAST_CHECK_KEY);
  } catch {}
}

function shouldCheckSession() {
  try {
    const last = Number(localStorage.getItem(LAST_CHECK_KEY) || "0");
    if (!Number.isFinite(last) || last <= 0) return true;
    return (nowMs() - last) > SESSION_CHECK_EVERY_MS;
  } catch {
    return true;
  }
}

function markSessionChecked() {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(nowMs()));
  } catch {}
}

// Redirige vers login si pas connecte
function requireAuth() {
  const prefix = getPrefix();
  const dest = window.location.pathname + window.location.search + window.location.hash;

  if (!isAuthed()) {
    window.location.replace(prefix + "login.html?redirect=" + encodeURIComponent(dest));
    return;
  }

  // Optionnel mais conseillé : vérif serveur, MAIS
  // - pas à chaque page (throttle)
  // - surtout : on NE LOGOUT PAS sur erreur réseau
  if (!shouldCheckSession()) return;

  fetch("/api/site/session", {
    credentials: "same-origin",
    cache: "no-store"
  })
    .then((res) => {
      markSessionChecked();

      // On ne déconnecte que si le serveur confirme que la session est invalide
      if (res.status === 401) {
        clearAuthed();
        window.location.replace(prefix + "login.html?redirect=" + encodeURIComponent(dest));
      }
    })
    .catch(() => {
      // IMPORTANT : ne rien faire. Pas de clearAuthed.
      // Si le réseau a un micro souci, on garde la session locale.
    });
}

// Verifie le mot de passe via l'API
function loginWith(pwd) {
  return fetch(LOGIN_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: String(pwd || "") })
  })
    .then(res => {
      if (res.ok) {
        setAuthed();
        return true;
      }
      return false;
    })
    .catch(() => false);
}

// Deconnexion
function logout() {
  clearAuthed();
  fetch("/api/site/logout", {
    method: "POST",
    credentials: "same-origin"
  }).catch(() => {}).finally(() => {
    window.location.href = getPrefix() + "login.html";
  });
}

// Redirect param (sécurisé)
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

function goAfterLogin() {
  const prefix = getPrefix();
  const target = getRedirectTarget();
  window.location.href = target ? target : (prefix + "index.html");
}

function wireLoginForm(options = {}) {
  const {
    formId = "loginForm",
    usernameId = "username",
    passwordId = "password",
    errorId = "loginError",
    forceUsername = SITE_USERNAME,
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

window.requireAuth = requireAuth;
window.loginWith = loginWith;
window.logout = logout;
window.wireLoginForm = wireLoginForm;
