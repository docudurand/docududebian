//pages publiques + login.html

const AUTH_KEY = "dd_auth_ok_v1";

// Nom d'utilisateur fixe (pour l'autofill)
const SITE_USERNAME = "durand";

// verification mot de passe
const LOGIN_ENDPOINT = "/api/site/login";

// Prefix pour servir le site depuis un sous-chemin
function getPrefix() {
  return (window.__SITE_PREFIX__ !== undefined) ? String(window.__SITE_PREFIX__) : "";
}

// Est-ce que la session est deja validee ?
function isAuthed() {
  return sessionStorage.getItem(AUTH_KEY) === "1";
}

// Marque la session comme validee
function setAuthed() {
  sessionStorage.setItem(AUTH_KEY, "1");
}

// Supprime la session
function clearAuthed() {
  sessionStorage.removeItem(AUTH_KEY);
}

// Redirige vers login si pas connecte
function requireAuth() {
  if (!isAuthed()) {
    const prefix = getPrefix();
    const dest = window.location.pathname + window.location.search + window.location.hash;
    window.location.replace(prefix + "login.html?redirect=" + encodeURIComponent(dest));
    return;
  }

  const prefix = getPrefix();
  const dest = window.location.pathname + window.location.search + window.location.hash;
  fetch("/api/site/session", {
    credentials: "same-origin",
    cache: "no-store"
  }).then((res) => {
    if (res.ok) return;
    clearAuthed();
    window.location.replace(prefix + "login.html?redirect=" + encodeURIComponent(dest));
  }).catch(() => {
    clearAuthed();
    window.location.replace(prefix + "login.html?redirect=" + encodeURIComponent(dest));
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

// Deconnexion simple
function logout() {
  clearAuthed();
  fetch("/api/site/logout", {
    method: "POST",
    credentials: "same-origin"
  }).catch(() => {}).finally(() => {
    window.location.href = getPrefix() + "login.html";
  });
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

// Branche un formulaire de login
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

// Expose les fonctions globalement
window.requireAuth = requireAuth;
window.loginWith = loginWith;
window.logout = logout;
window.wireLoginForm = wireLoginForm;
