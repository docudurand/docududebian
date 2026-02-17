// routes API presences (saisie, export, conges)

import express from "express";
import ftp from "basic-ftp";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "node:crypto";

// routeur Express separe
const router = express.Router();

// Config FTP et fichiers presences
const FTP_ROOT_BASE = (process.env.FTP_BACKUP_FOLDER || "/").replace(/\/$/, "");
const FTP_ROOT = `${FTP_ROOT_BASE}/presences`;
const LEAVES_FILE = `${FTP_ROOT}/leaves.json`;
const LEAVES_ADMIN_TOKEN = (process.env.PRESENCES_LEAVES_PASSWORD || "").trim();
const GS_URL = process.env.GS_PRESENCES_URL || "";

// dates
const yyyymm = (dateStr = "") => String(dateStr).slice(0, 7);
const tmpFile = (name) => path.join(os.tmpdir(), name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FTP_DEBUG = String(process.env.PRESENCES_FTP_DEBUG || "0") === "1";
const isWE = (d) => { const x = d.getDay(); return x === 0 || x === 6; };

// Jours feries (a mettre a jour chaque annee)
const HOLIDAYS = new Set([
  "2025-01-01",
  "2025-04-21",
  "2025-05-01",
  "2025-05-08",
  "2025-05-29",
  "2025-06-09",
  "2025-07-14",
  "2025-08-15",
  "2025-11-01",
  "2025-11-11",
  "2025-12-25",
]);
function isHoliday(isoDate) { return HOLIDAYS.has(String(isoDate)); }

function tlsOptions() {
  const rejectUnauthorized = String(process.env.FTP_TLS_REJECT_UNAUTH || "1") === "1";
  const servername = process.env.FTP_HOST || undefined;
  return { rejectUnauthorized, servername };
}
// Ouvre une session FTP
async function openFtp() {
  const client = new ftp.Client(30_000);
  if (FTP_DEBUG) client.ftp.verbose = true;
  await client.access({
    host: process.env.FTP_HOST,
    user: process.env.FTP_USER,
    password: process.env.FTP_PASS || process.env.FTP_PASSWORD,
    port: process.env.FTP_PORT ? Number(process.env.FTP_PORT) : 21,
    secure: String(process.env.FTP_SECURE || "false") === "true",
    secureOptions: tlsOptions(),
  });
  try { client.ftp.socket?.setKeepAlive?.(true, 10_000); } catch {}
  return client;
}
async function ensureDir(client, remoteDir) { await client.ensureDir(remoteDir); }

// Telecharge un JSON depuis FTP
async function tryDownloadJSON(client, remotePath) {
  const out = tmpFile("pres_" + Date.now() + ".json");
  try {
    await client.downloadTo(out, remotePath);
    const txt = fs.readFileSync(out, "utf8");
    return JSON.parse(txt);
  } catch {
    if (FTP_DEBUG) console.warn("[PRES][FTP] download fail:", remotePath);
    return null;
  } finally { try { fs.unlinkSync(out); } catch {} }
}
// Ecrit un JSON sur FTP
async function writeJSON(client, remotePath, obj) {
  const dir = path.posix.dirname(remotePath);
  await ensureDir(client, dir);
  const out = tmpFile("pres_" + Date.now() + ".json");
  fs.writeFileSync(out, JSON.stringify(obj));
  await client.uploadFrom(out, remotePath);
  try { fs.unlinkSync(out); } catch {}
}
// wrapper FTP avec retry
async function withFtp(actionLabel, fn, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let client;
    try {
      client = await openFtp();
      const result = await fn(client);
      try { client.close(); } catch {}
      return result;
    } catch (e) {
      lastErr = e;
      try { client?.close(); } catch {}
      if (attempt < retries) {
        console.warn(`[PRES/FTP] ${actionLabel} tentative ${attempt + 1} échouée:`, e?.message || e);
        await sleep(300 + attempt * 500);
        continue;
      }
    }
  }
  throw lastErr;
}

// Verifie le token admin (conges)
function safeEqual(expected, provided) {
  const a = Buffer.from(String(expected || ""), "utf8");
  const b = Buffer.from(String(provided || ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function extractAdminToken(req) {
  const headerToken = req.get("X-Admin-Token");
  if (headerToken) return String(headerToken).trim();

  const auth = req.get("Authorization");
  if (auth) {
    const value = String(auth).trim();
    if (value.toLowerCase().startsWith("bearer ")) {
      return value.slice(7).trim();
    }
  }
  return "";
}

function authOk(req) {
  if (!LEAVES_ADMIN_TOKEN) return false;
  const token = extractAdminToken(req);
  return safeEqual(LEAVES_ADMIN_TOKEN, token);
}

function requireAdminToken(req, res, next) {
  if (!LEAVES_ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, error: "admin_token_not_configured" });
  }
  if (!authOk(req)) {
    return res.status(401).json({ ok: false, error: "auth_required" });
  }
  return next();
}
// Traduit un statut en francais
function frStatus(s) {
  switch (String(s || "").toLowerCase()) {
    case "pending": return "en attente";
    case "accepted": return "validée";
    case "rejected": return "refusée";
    case "cancelled": return "annulée";
    default: return String(s || "");
  }
}
const MAIN_CODES = ['P','CP','AM','AT','F','Cep','Ann','SS','E','R','D','RI','UST','NP'];
const PSITE_CODES = Array.from({length:20}, (_,i)=>`P${i+1}`);
const ALL_CODES = new Set([...MAIN_CODES, ...PSITE_CODES]);

// Ajuste les CP dans Google Sheets (si GS_URL configure)
async function gsAdjustCP({ magasin, nom, prenom, delta }) {
  if (!GS_URL) {
    console.warn("[GS] GS_PRESENCES_URL non défini — pas d’ajustement CP");
    return { ok: false, reason: "no_gs_url" };
  }
  try {
    const resp = await fetch(`${GS_URL}?action=deccp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ magasin, nom, prenom, nbJours: delta }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json?.ok === false) {
      console.warn("[GS] Ajustement CP échoué:", resp.status, json);
      return { ok: false, status: resp.status, body: json };
    }
    return { ok: true, body: json };
  } catch (e) {
    console.warn("[GS] Ajustement CP erreur:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

// Determine les slots a marquer sur une plage
async function resolveSlotsForRangeMark({ magasin, nom, prenom, slotsFromBody }) {
  const fallback = ['Matin', 'A. Midi'];

  const cleaned = Array.isArray(slotsFromBody)
    ? slotsFromBody.map(s => String(s||'').trim()).filter(Boolean)
    : [];
  if (cleaned.length) return cleaned;

  if (!prenom && GS_URL) {
    try {
      const r = await fetch(`${GS_URL}?action=personnel&magasin=${encodeURIComponent(magasin)}`);
      if (r.ok) {
        const pers = await r.json();
        const slots = pers?.livreurs?.[String(nom||'').trim()] || null;
        if (Array.isArray(slots) && slots.length) return slots.map(s=>String(s||'').trim()).filter(Boolean);
      }
    } catch (e) {
      console.warn("[GS] resolveSlotsForRangeMark personnel fail:", e?.message||e);
    }
  }

  return fallback;
}

// API: liste personnel par magasin
router.get("/personnel", async (req, res) => {
  const magasin = String(req.query.magasin || "");
  if (GS_URL) {
    try {
      const resp = await fetch(`${GS_URL}?action=personnel&magasin=${encodeURIComponent(magasin)}`);
      if (resp.ok) return res.json(await resp.json());
    } catch (e) { console.warn("[PRES] personnel fallback:", e?.message || e); }
  }
  return res.json({ employes: [], interims: [], livreurs: {} });
});

// API: liste employes
router.get("/employes", async (req, res) => {
  const magasin = String(req.query.magasin || "");
  try {
    if (GS_URL) {
      try {
        const r = await fetch(`${GS_URL}?action=employes&magasin=${encodeURIComponent(magasin)}`);
        if (r.ok) {
          const json = await r.json();
          if (json && Array.isArray(json.employes)) return res.json(json);
        }
      } catch (e) {}
      try {
        const r2 = await fetch(`${GS_URL}?action=personnel&magasin=${encodeURIComponent(magasin)}`);
        if (r2.ok) {
          const pers = await r2.json();
          const employes = (pers?.employes || []).map(p => ({
            nom: p.nom || "",
            prenom: p.prenom || "",
            congeRestant: p.congeRestant ?? null
          }));
          return res.json({ employes });
        }
      } catch (e2) {}
    }
    return res.json({ employes: [] });
  } catch (e) {
    console.error("[PRES] /employes error:", e?.message || e);
    return res.status(200).json({ employes: [] });
  }
});

// API: sauvegarde d'une journee
router.post("/save", requireAdminToken, express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const { magasin, date, data } = req.body || {};
    if (!magasin || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")))
      return res.status(400).json({ ok: false, error: "invalid_params" });

    await withFtp("save-day", async (client) => {
      const month = yyyymm(date);
      const remoteFile = `${FTP_ROOT}/${month}/${magasin}.json`;
      const file = (await tryDownloadJSON(client, remoteFile)) || {};
      file[date] = { data, savedAt: new Date().toISOString() };
      await writeJSON(client, remoteFile, file);
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("[PRES] save error:", e?.message || e);
    res.status(500).json({ ok: false, error: "save_failed" });
  }
});

// API: lecture d'une journee
router.get("/day", requireAdminToken, async (req, res) => {
  try {
    const magasin = String(req.query.magasin || "").trim();
    const date = String(req.query.date || "").trim();
    if (!magasin || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ ok: false, error: "invalid_params" });

    const month = yyyymm(date);
    const remoteFile = `${FTP_ROOT}/${month}/${magasin}.json`;
    const file = await withFtp("day-read", async (client) =>
      (await tryDownloadJSON(client, remoteFile)) || {}
    );
    const block = file[date]?.data || { rows: [] };
    return res.json({ ok: true, data: block });
  } catch (e) {
    console.error("[PRES] day error:", e?.message || e);
    return res.status(200).json({ ok: true, data: { rows: [] } });
  }
});

// API: recupere le mois complet
router.get("/month-store", requireAdminToken, async (req, res) => {
  try {
    const month = String(req.query.yyyymm || "").trim();
    const magasin = String(req.query.magasin || "").trim();
    if (!/^\d{4}-\d{2}$/.test(month) || !magasin)
      return res.status(400).json({ ok: false, error: "invalid_params" });

    const remoteFile = `${FTP_ROOT}/${month}/${magasin}.json`;
    const file = await withFtp("month-store-read", async (client) =>
      (await tryDownloadJSON(client, remoteFile)) || {}
    );

    let personnel = { employes: [], interims: [], livreurs: {} };
    if (GS_URL) {
      try {
        const resp = await fetch(`${GS_URL}?action=personnel&magasin=${encodeURIComponent(magasin)}`);
        if (resp.ok) { personnel = await resp.json(); }
      } catch (e) {}
    }

    return res.json({ ok: true, file, personnel });
  } catch (e) {
    console.error("[PRES] month-store error:", e?.message || e);
    return res.json({ ok: true, file: {}, personnel: { employes: [], interims: [], livreurs: {} } });
  }
});

// API admin: liste des conges
router.get("/leaves", requireAdminToken, async (req, res) => {
  try {
    const raw = await withFtp("leaves-get", async (client) =>
      (await tryDownloadJSON(client, LEAVES_FILE)) || []
    );
    const leaves = raw.map((l) => ({ ...l, statusFr: l.statusFr || frStatus(l.status) }));
    res.json({ ok: true, leaves });
  } catch (e) {
    console.error("[LEAVES] get error:", e?.message || e);
    res.status(500).json({ ok: false, error: "leaves_read_failed" });
  }
});

// API admin: decision sur un conge
router.post("/leaves/decision", requireAdminToken, express.json({ limit: "1mb" }), async (req, res) => {
  const { id, decision, reason } = req.body || {};
  if (!id || !decision || !/^(accept|reject|cancel)$/i.test(decision))
    return res.status(400).json({ ok: false, error: "invalid_params" });

  try {
    await withFtp("leaves-decision", async (client) => {
      const leaves = (await tryDownloadJSON(client, LEAVES_FILE)) || [];
      const idx = leaves.findIndex((l) => String(l.id) === String(id));
      if (idx < 0) throw new Error("leave_not_found");
      const item = leaves[idx];

      const start = new Date(item.dateDu);
      const end = new Date(item.dateAu);

      const normalize = (s) => String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim().toUpperCase();
      const WANTED_KEY = normalize(`${item.nom || ""} ${item.prenom || ""}`);
      const CANON_LABEL = `${(item.nom || "").toUpperCase()} ${(item.prenom || "").toUpperCase()}`;
      const DEF_SLOTS = ["Matin", "A. Midi"];

      const act = decision.toLowerCase();

      if (act === "accept") {
        if (item.status !== "pending") throw new Error("already_decided");
        item.status = "accepted";
        item.statusFr = frStatus(item.status);
        item.reason = reason || "";
        item.decidedAt = new Date().toISOString();

        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          if (isWE(d)) continue;

          const dkUTC = new Date(d).toISOString().slice(0, 10);
          const dkLOC = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          for (const dk of new Set([dkUTC, dkLOC])) {
            if (isHoliday(dk)) continue;

            const month = dk.slice(0, 7);
            const remote = `${FTP_ROOT}/${month}/${item.magasin}.json`;
            const file = (await tryDownloadJSON(client, remote)) || {};
            const dayBlock = file[dk]?.data || { rows: [] };

            let row = (dayBlock.rows || []).find((r) => normalize(r.label) === WANTED_KEY);
            if (!row) { row = { label: CANON_LABEL, values: {} }; dayBlock.rows.push(row); }

            DEF_SLOTS.forEach((s) => { row.values[s] = "CP"; });

            file[dk] = { data: dayBlock, savedAt: new Date().toISOString() };
            await writeJSON(client, remote, file);
          }
        }
        const n = Math.max(0, Number(item.nbJours || 0));
        if (n > 0) await gsAdjustCP({ magasin: item.magasin, nom: item.nom, prenom: item.prenom, delta: n });
      }
      else if (act === "reject") {
        if (item.status !== "pending") throw new Error("already_decided");
        item.status = "rejected";
        item.statusFr = frStatus(item.status);
        item.reason = reason || "";
        item.decidedAt = new Date().toISOString();
      }
      else {
        if (item.status !== "accepted") throw new Error("not_accepted");
        item.status = "cancelled";
        item.statusFr = frStatus(item.status);
        item.cancelledAt = new Date().toISOString();
        item.reason = reason || item.reason || "";

        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const dkUTC = new Date(d).toISOString().slice(0, 10);
          const dkLOC = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          for (const dk of new Set([dkUTC, dkLOC])) {
            const month = dk.slice(0, 7);
            const remote = `${FTP_ROOT}/${month}/${item.magasin}.json`;
            const file = (await tryDownloadJSON(client, remote)) || {};
            const dayBlock = file[dk]?.data || { rows: [] };

            const row = (dayBlock.rows || []).find((r) => normalize(r.label) === WANTED_KEY);
            if (!row) continue;

            let changed = false;
            for (const slot of Object.keys(row.values || {})) {
              const cur = String(row.values[slot] ?? "").trim();
              if (cur === "CP") { row.values[slot] = ""; changed = true; }
            }
            if (changed) {
              file[dk] = { data: dayBlock, savedAt: new Date().toISOString() };
              await writeJSON(client, remote, file);
            }
          }
        }
        const n = Math.max(0, Number(item.nbJours || 0));
        if (n > 0) await gsAdjustCP({ magasin: item.magasin, nom: item.nom, prenom: item.prenom, delta: -n });
      }

      await writeJSON(client, LEAVES_FILE, leaves);
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("[LEAVES] decision error:", e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || "decision_failed" });
  }
});

// API admin: marquer un code sur une plage de dates
router.post("/range-mark", requireAdminToken, express.json({ limit: "1mb" }), async (req, res) => {

  const { magasin, nom, prenom, code, dateDu, dateAu, slots } = req.body || {};
  if (!magasin || !nom || !code || !dateDu || !dateAu)
    return res.status(400).json({ ok:false, error:"invalid_params" });
  if (!ALL_CODES.has(String(code)))
    return res.status(400).json({ ok:false, error:"invalid_code" });

  const start = new Date(dateDu), end = new Date(dateAu);
  if (isNaN(start) || isNaN(end) || end < start)
    return res.status(400).json({ ok:false, error:"invalid_dates" });

  const normalize = (s) => String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim().toUpperCase();
  const WANTED_KEY = normalize(`${nom||""} ${prenom||""}`);
  const CANON_LABEL = `${(nom||"").toUpperCase()} ${(prenom||"").toUpperCase()}`;

  try{
    const slotList = await resolveSlotsForRangeMark({ magasin, nom, prenom, slotsFromBody: slots });

    await withFtp("range-mark", async (client) => {
      for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
        if (isWE(d)) continue;

        const dkUTC = new Date(d).toISOString().slice(0,10);
        const dkLOC = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

        for (const dk of new Set([dkUTC, dkLOC])) {
          if (isHoliday(dk)) continue;

          const month = dk.slice(0,7);
          const remote = `${FTP_ROOT}/${month}/${magasin}.json`;
          const file = (await tryDownloadJSON(client, remote)) || {};
          const dayBlock = file[dk]?.data || { rows: [] };

          let row = (dayBlock.rows || []).find(r => normalize(r.label) === WANTED_KEY);
          if (!row) { row = { label: CANON_LABEL, values: {} }; dayBlock.rows.push(row); }

          slotList.forEach(s => { row.values[s] = code; });

          file[dk] = { data: dayBlock, savedAt: new Date().toISOString() };
          await writeJSON(client, remote, file);
        }
      }
    });
    res.json({ ok:true });
  }catch(e){
    console.error("[RANGE] error:", e?.message||e);
    res.status(500).json({ ok:false, error:"range_failed" });
  }
});

export default router;
