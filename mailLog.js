// journalisation des emails via Google Apps Script
//
// IMPORTANT (anti-doublons):
// - L'envoi SMTP et le log Google Apps Script sont decouples.
// - Si le mail est parti mais que le log echoue (timeout / aborted / Apps Script HS),
//   on NE DOIT PAS re-tenter l'envoi, sinon les destinataires recoivent des doublons.

const GS_URL = process.env.GS_MAIL_LOG_URL || "";
const TIMEOUT = Number(process.env.GS_MAIL_LOG_TIMEOUT_MS || 15000);

// sans URL, on ne peut pas logger
function assertConfigured() {
  if (!GS_URL) {
    throw new Error("[MAIL_LOG] GS_MAIL_LOG_URL manquant (Apps Script Web App).");
  }
}

// Petit helper pour timeout des requetes
function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { ctrl, clear: () => clearTimeout(t) };
}

// Requete HTTP qui renvoie du JSON
async function httpJson(url, options = {}) {
  const { ctrl, clear } = withTimeout(TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      throw new Error(`[MAIL_LOG] HTTP ${res.status} ${res.statusText} :: ${text}`.slice(0, 500));
    }
    return data;
  } finally {
    clear();
  }
}

// Ajoute une ligne de log (envoi reussi ou echoue)
export async function addMailLog(entry) {
  assertConfigured();
  const payload = { action: "appendMailLog", entry };
  return httpJson(GS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
}

// Liste des logs (avec filtre optionnel)
export async function getMailLogs({ limit = 200, q = "" } = {}) {
  assertConfigured();
  const u = new URL(GS_URL);
  u.searchParams.set("action", "listMailLogs");
  u.searchParams.set("limit", String(limit));
  if (q) u.searchParams.set("q", q);
  return httpJson(u.toString(), { method: "GET" });
}

// Envoie un mail ET cree un log (success/fail)
// IMPORTANT: si le mail est parti mais que le log echoue, on NE RETENTE PAS l'envoi.
export async function sendMailWithLog(transporter, mailOptions, formType, meta = {}, opts = {}) {
  const { logFailed = true } = opts || {};

  const toField = Array.isArray(mailOptions?.to) ? mailOptions.to.join(",") : (mailOptions?.to || "");
  const subject = String(mailOptions?.subject || "");

  const base = {
    ts: new Date().toISOString(),
    to: String(toField || ""),
    subject,
    formType: String(formType || "unknown"),
    meta,
  };

  // 1) Envoi SMTP
  let info;
  try {
    info = await transporter.sendMail(mailOptions);
  } catch (err) {
    // SMTP KO -> on peut logger "failed" (best effort), puis on throw (normal)
    const msg = String(err?.message || err);
    if (logFailed) {
      try { await addMailLog({ ...base, status: "failed", error: msg }); } catch {}
    }
    throw err;
  }

  // 2) Log "sent" (best effort) — mais surtout ne jamais faire echouer l'envoi
  try {
    await addMailLog({ ...base, status: "sent", messageId: info?.messageId || "" });
  } catch (e) {
    console.warn("[MAIL_LOG] log failed but email was sent:", String(e?.message || e));
  }

  return info;
}
