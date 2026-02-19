import express from "express";
import rateLimit from "express-rate-limit";
import qrcode from "qrcode";
import crypto from "crypto";
import ftp from "basic-ftp";
import fs from "fs";
import os from "os";
import pathModule from "path";

import * as ftpStorage from "../ftpStorage.js";
import { registry, getByKey } from "../jsonRegistry.js";
import { seedFournisseurPl, seedSiteIdentificationOe, seedFournisseurVl } from "../jsonSeedFromHtml.js";
import {
  loadAuth,
  saveAuth,
  generateTotpSecret,
  buildOtpAuthUrl,
  verifyTotp,
  makeBackupCodes,
  consumeBackupCode,
} from "../admin2fa.js";

function ensureCsrf(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = cryptoRandom();
  }
  return req.session.csrfToken;
}

function cryptoRandom() {
  return crypto.randomBytes(16).toString("hex");
}

function requireAuth(req, res, next) {
  if (req.session?.adminAuthed) return next();
  return res.status(401).json({ ok: false, error: "not_authenticated" });
}

function requireCsrf(req, res, next) {
  const token = req.session?.csrfToken || "";
  const provided =
    String(req.get("x-csrf-token") || "") ||
    String(req.body?.csrfToken || "");
  if (!token || !provided || token !== provided) {
    return res.status(403).json({ ok: false, error: "csrf_invalid" });
  }
  return next();
}


// --- EXTRA JSON ENTRIES (added for Kilométrage params.json) ---
const EXTRA_JSON_ENTRIES = [
  {
    key: "kilometrage-params",
    label: "Paramètres Kilométrage",
    page: "kilometrage",
    filename: "service/kilometrage/params.json",
    schema: "kilometrage_params",
  },
  {
    key: "kilometrage-saisies",
    label: "Saisies Kilométriques",
    page: "kilometrage",
    filename: null,   // accès dynamique via routes dédiées /api/km-editor/*
    schema: "kilometrage_saisies",
  },
];

// ─── Helpers FTP spécifiques kilométrage ─────────────────────────────────────
function getKmFtpConfig() {
  const host     = String(process.env.FTP_HOST     || "").trim();
  const user     = String(process.env.FTP_USER     || "").trim();
  const password = String(process.env.FTP_PASS     || process.env.FTP_PASSWORD || "").trim();
  const port     = process.env.FTP_PORT ? Number(process.env.FTP_PORT) : 21;
  const secure   = String(process.env.FTP_SECURE   || "false").toLowerCase() === "true";
  const rejectUnauthorized = String(process.env.FTP_TLS_REJECT_UNAUTH || "").trim() !== "0";
  const insecure = String(process.env.FTP_TLS_INSECURE || "").trim() === "1";
  const baseDir  = String(process.env.KM_FTP_DIR || process.env.FTP_BASE_DIR || "/kilometrage")
    .trim().replace(/\/+$/, "");
  return { host, user, password, port, secure, rejectUnauthorized, insecure, baseDir };
}

function kmTmpFile(prefix) {
  const rnd = crypto.randomBytes(6).toString("hex");
  return path.join(os.tmpdir(), `kmadmin_${prefix}_${Date.now()}_${rnd}`);
}

async function kmConnectFtp() {
  const cfg = getKmFtpConfig();
  if (!cfg.host || !cfg.user || !cfg.password) throw new Error("FTP_HOST/FTP_USER/FTP_PASS manquants");
  const client = new ftp.Client(30_000);
  client.ftp.verbose = false;
  await client.access({
    host: cfg.host, user: cfg.user, password: cfg.password,
    port: cfg.port, secure: cfg.secure,
    secureOptions: { rejectUnauthorized: cfg.rejectUnauthorized && !cfg.insecure, servername: cfg.host || undefined },
  });
  try { client.ftp.socket?.setKeepAlive?.(true, 10_000); } catch {}
  return client;
}

async function kmWithFtp(fn) {
  let client;
  try { client = await kmConnectFtp(); return await fn(client); }
  finally { try { client?.close(); } catch {} }
}

function kmSanitizeAgence(code) {
  return String(code || "INCONNU").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_\-]/g, "_").toUpperCase().replace(/_+/g, "_").replace(/^_|_$/g, "") || "INCONNU";
}

async function kmReadJson(remotePath) {
  const tmp = kmTmpFile("read");
  return kmWithFtp(async (client) => {
    try {
      await client.downloadTo(tmp, remotePath);
      const raw = fs.readFileSync(tmp, "utf8").trim();
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    } catch (err) {
      if (String(err?.message || "").includes("550")) return null;
      throw err;
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  });
}

async function kmWriteJson(remotePath, data) {
  const tmp = kmTmpFile("write");
  return kmWithFtp(async (client) => {
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
      await client.ensureDir(path.posix.dirname(remotePath));
      await client.uploadFrom(tmp, remotePath);
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  });
}

function kmMonthlyPath(codeAgence, yearMonth) {
  const { baseDir } = getKmFtpConfig();
  const dir = kmSanitizeAgence(codeAgence);
  return path.posix.join(baseDir, dir, `${yearMonth}.json`);
}

function kmParamsPath() {
  const { baseDir } = getKmFtpConfig();
  return path.posix.join(baseDir, "params.json");
}
// ─── fin helpers FTP kilométrage ─────────────────────────────────────────────

function resolveJsonEntry(key) {
  const k = String(key || "").trim();
  // try registry from jsonRegistry.js first
  const entry = getByKey(k);
  if (entry) return entry;
  // then extras
  return EXTRA_JSON_ENTRIES.find(e => e.key === k) || null;
}

function getRegistryWithExtras() {
  // avoid mutating imported registry; just extend for UI
  return Array.isArray(registry) ? [...registry, ...EXTRA_JSON_ENTRIES] : [...EXTRA_JSON_ENTRIES];
}
// --- end EXTRA JSON ENTRIES ---

// ═══════════════════════════════════════════════════════════════════════════
// KILOMÉTRAGE : helpers FTP dédiés (base dir = KM_FTP_DIR)
// ═══════════════════════════════════════════════════════════════════════════
function kmFtpConfig() {
  const host     = String(process.env.FTP_HOST || "").trim();
  const user     = String(process.env.FTP_USER || "").trim();
  const password = String(process.env.FTP_PASS || process.env.FTP_PASSWORD || "").trim();
  const port     = process.env.FTP_PORT ? Number(process.env.FTP_PORT) : 21;
  const secure   = String(process.env.FTP_SECURE || "false").toLowerCase() === "true";
  const baseDir  = String(process.env.KM_FTP_DIR || process.env.FTP_BASE_DIR || "/kilometrage")
    .trim().replace(/\/+$/, "");
  return { host, user, password, port, secure, baseDir };
}

function kmSanitizeAgence(code) {
  return String(code || "INCONNU")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9_\-]/gi, "_")
    .toUpperCase();
}

function kmMonthPath(codeAgence, yearMonth) {
  const { baseDir } = kmFtpConfig();
  const dir = kmSanitizeAgence(codeAgence);
  return pathModule.posix.join(baseDir, dir, `${yearMonth}.json`);
}

function kmTmpFile() {
  return pathModule.join(os.tmpdir(), `km_admin_${crypto.randomBytes(6).toString("hex")}.tmp`);
}

async function withKmFtp(fn) {
  const { host, user, password, port, secure } = kmFtpConfig();
  const client = new ftp.Client(20000);
  client.ftp.verbose = false;
  try {
    await client.access({ host, user, password, port, secure, secureOptions: { rejectUnauthorized: false } });
    return await fn(client);
  } finally {
    client.close();
  }
}

async function kmReadJson(remotePath) {
  const tmp = kmTmpFile();
  try {
    await withKmFtp(async (client) => {
      await client.downloadTo(tmp, remotePath);
    });
    const text = fs.readFileSync(tmp, "utf-8");
    return JSON.parse(text);
  } catch (e) {
    if (String(e?.code || e?.message || "").includes("550")) return null; // file not found
    throw e;
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

async function kmWriteJson(remotePath, data) {
  const tmp = kmTmpFile();
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    await withKmFtp(async (client) => {
      // ensure directory exists
      const dir = pathModule.posix.dirname(remotePath);
      await client.ensureDir(dir);
      await client.uploadFrom(tmp, remotePath);
    });
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

// List agence dirs available in KM base dir
async function kmListAgences() {
  const { baseDir } = kmFtpConfig();
  return withKmFtp(async (client) => {
    const list = await client.list(baseDir);
    return list
      .filter(e => e.type === 2 /* directory */)
      .map(e => e.name)
      .filter(n => n !== "." && n !== "..");
  });
}

// List YYYY-MM available for an agence (from filenames like 2026-02.json)
async function kmListMonths(codeAgence) {
  const { baseDir } = kmFtpConfig();
  const dir = pathModule.posix.join(baseDir, kmSanitizeAgence(codeAgence));
  return withKmFtp(async (client) => {
    let list;
    try {
      list = await client.list(dir);
    } catch { return []; }
    return list
      .filter(e => e.type === 1 /* file */ && e.name.match(/^\d{4}-\d{2}\.json$/))
      .map(e => e.name.replace(".json", ""))
      .sort();
  });
}
// ─── fin helpers km ─────────────────────────────────────────────────────────

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
  <style>
    :root{color-scheme:light}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:0;padding:24px;background:#f6f7fb;color:#0f172a}
    .wrap{max-width:none;margin:0 auto;width:100%}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:22px;box-shadow:0 10px 30px rgba(0,0,0,.06);width:100%}
    h1{font-size:22px;margin:0 0 12px}
    label{display:block;font-weight:700;margin:14px 0 6px}
    input,select,textarea,button{font:inherit}
    input,select,textarea{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:10px;background:#fff}
    textarea{min-height:unset;height:auto;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
#jsonArea{min-height:260px}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .btn{background:#2563eb;color:#fff;border:0;padding:10px 16px;border-radius:10px;cursor:pointer;font-weight:700}
    .btn.secondary{background:#e5e7eb;color:#111}
    .btn.danger{background:#b91c1c}
    .msg{margin-top:10px;font-weight:700}
    .muted{color:#6b7280;font-size:13px}
    table{width:100%;border-collapse:separate;border-spacing:0 10px}
td{vertical-align:top;padding:8px}
.wide{overflow:auto;border:1px solid #eef2f7;border-radius:14px;padding:12px;background:#fafbff;margin-bottom:30px}
	code{background:#eef2ff;padding:2px 6px;border-radius:6px}
    th{position:sticky;top:0;background:#f8fafc;border-bottom:1px solid #e5e7eb;padding:10px 8px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
    .grid{display:grid;gap:26px}
    .section-title{font-weight:800;margin:16px 0 10px}
    @media (max-width: 900px){
      body{padding:12px}
      .wrap{max-width:100%}
      th{font-size:11px}
    }
	input,select,textarea{box-sizing:border-box}
td{overflow:hidden}
th:last-child, td:last-child{width:140px; white-space:nowrap}
  </style>
</head>
<body>
  <div class="wrap">
    ${body}
  </div>
</body>
</html>`;
}

function editorPage(baseUrl, csrfToken) {
  const registryJson = JSON.stringify(getRegistryWithExtras());
  return htmlPage("Editeur JSON", `
  <div class="card">
    <h1>Editeur JSON</h1>
    <div class="muted">Accès protégé 2FA. Dernière modification affichée après chargement.</div>
    <label for="pageKey">Choisir la page à modifier</label>
    <select id="pageKey"></select>
    <div class="row" style="margin-top:12px">
      <button class="btn" id="btnLoad" type="button">Charger</button>
    </div>
    <div id="editorArea" class="grid" style="margin-top:14px"></div>
    <details style="margin-top:12px">
      <summary class="muted" style="cursor:pointer">JSON brut (avancé)</summary>
      <textarea id="jsonArea" spellcheck="false" style="margin-top:8px"></textarea>
    </details>
    <div class="row" style="margin-top:10px">
      <div class="muted">Dernière modification: <span id="lastMod">—</span></div>
    </div>
    <div class="row" style="margin-top:14px; justify-content:flex-end">
      <button class="btn" id="btnSave" type="button">Enregistrer</button>
    </div>
    <form method="POST" action="${baseUrl}/logout" style="margin-top:12px">
      <input type="hidden" name="csrfToken" value="${csrfToken}"/>
      <button class="btn danger" type="submit">Logout</button>
    </form>
    <div class="msg" id="msg"></div>
  </div>
  <script>
    const BASE = ${JSON.stringify(baseUrl)};
    const CSRF = ${JSON.stringify(csrfToken)};
    const registry = ${registryJson};
    const sel = document.getElementById("pageKey");
    const area = document.getElementById("jsonArea");
    const editorArea = document.getElementById("editorArea");
    const msg = document.getElementById("msg");
    const lastMod = document.getElementById("lastMod");
    let currentData = null;
    let currentKey = null;

    registry.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.key;
      opt.textContent = r.label + " (" + r.page + ")";
      sel.appendChild(opt);
    });

    const schemas = {

      kilometrage_params: { type: "table", columns: [
        { key: "agence", label: "Agence" },
        { key: "codeAgence", label: "Code Agence" },
        { key: "tournee", label: "Tournée" },
        { key: "codeTournee", label: "Code Tournée" },
        { key: "transporteur", label: "Transporteur / Livreur" },
        { key: "codeTransporteur", label: "Code Transporteur" },
        { key: "id", label: "ID" },
        { key: "dernierRemplacement", label: "Dernier remplacement (ISO)" }
      ]},
      links: { type: "table", columns: [
        { key: "label", label: "Label" },
        { key: "url", label: "URL" }
      ]},
      fournisseur_pl: { type: "table", columns: [
        { key: "fournisseur", label: "Fournisseur" },
        { key: "code", label: "Code" },
        { key: "pieces", label: "Pièces", multiline: true, rows: 2 }
      ]},
      site_identification_oe: { type: "table", columns: [
        { key: "marque", label: "Marque" },
        { key: "url", label: "URL" },
        { key: "note", label: "Note" }
      ]},
      fournisseurs_ramasse: { type: "table", columns: [
        { key: "name", label: "Fournisseur" },
        { key: "magasin", label: "Magasin" },
        { key: "recipients", label: "Destinataires (séparés par ,)" },
        { key: "cc", label: "CC (séparés par ,)" },
        { key: "infoLivreur", label: "Info livreur" }
      ]},
      contacts_fournisseurs: { type: "rowTable", columns: [
        "Fournisseur",
        "ADV - Contact",
        "ADV - Téléphone",
        "ADV - Mail",
        "Commerce - Contact",
        "Commerce - Téléphone",
        "Commerce - Mail"
      ]},
      retour_garantie_vl: { type: "multi", blocks: [
        {
          key: "mailsRetour",
          label: "Mails retour",
          type: "table",
          columns: [
            { key: "fournisseur", label: "Fournisseur" },
            { key: "email", label: "Email" }
          ]
        },
        {
          key: "contactsGarantie",
          label: "Contacts garantie",
          type: "table",
          columns: [
            { key: "fournisseur", label: "Fournisseur" },
            { key: "suivie", label: "Contact suivie" },
            { key: "demande", label: "Contact demande" },
            { key: "commercial", label: "Contact commercial" },
            { key: "notes", label: "Notes", multiline: true, rows: 2 }
          ]
        }
      ]},
      atelier_data: { type: "multi", blocks: [
        {
          key: "lignes",
          label: "Lignes",
          type: "table",
          columns: [
            { key: "ligne", label: "Ligne" },
            { key: "libelle", label: "Libellé" }
          ]
        },
        {
          key: "regles",
          label: "Règles",
          type: "table",
          columns: [
            { key: "service", label: "Service" },
            { key: "ligne", label: "Ligne" },
            { key: "cylindres", label: "Cylindres" },
            { key: "soupapes", label: "Soupapes" },
            { key: "carburant", label: "Carburant" },
            { key: "vl_pl", label: "VL/PL" },
            { key: "reference", label: "Référence" },
            { key: "libelleref", label: "Libellé ref" },
            { key: "prixht", label: "Prix HT" }
          ]
        }
      ]},
      fournisseur_vl: { type: "multi", blocks: [
        {
          key: "categories",
          label: "Fournisseurs par catégorie",
          type: "group",
          groupLabel: "Catégorie",
          columns: [
            { key: "name", label: "Fournisseur" },
            { key: "url", label: "URL" },
            { key: "delais", label: "Délais" },
            { key: "heureLimite", label: "Heure limite" },
            { key: "infos", label: "Infos", multiline: true, rows: 2 }
          ]
        },
        {
          key: "depots",
          label: "Liste dépôt",
          type: "group",
          groupLabel: "Dépôt",
          columns: [
            { key: "name", label: "Fournisseur" },
            { key: "code", label: "Code" }
          ]
        },
        {
          key: "back2car",
          label: "Code Back 2 Car",
          type: "table",
          columns: [
            { key: "site", label: "Site / Agence" },
            { key: "code", label: "Code" }
          ]
        },
        {
          key: "hubCodes",
          label: "Code fournisseur HUB",
          type: "table",
          columns: [
            { key: "label", label: "Libellé" }
          ]
        }
      ]}
      kilometrage_saisies: { type: "km_saisies" },
    };

    function setMsg(text, ok) {
      msg.textContent = text || "";
      msg.style.color = ok ? "green" : "crimson";
    }

    function createInput(value, col) {
      if (col && col.multiline) {
        const ta = document.createElement("textarea");
        ta.value = value || "";
        ta.rows = col.rows || 3;
        return ta;
      }
      const input = document.createElement("input");
      input.type = "text";
      input.value = value || "";
      return input;
    }

    function renderTable(container, rows, columns) {
      const wrap = document.createElement("div");
      wrap.className = "wide";
      const table = document.createElement("table");
      table.innerHTML = "<thead><tr>" + columns.map(c => "<th>" + (c.label || c) + "</th>").join("") + "<th></th></tr></thead>";
      const tbody = document.createElement("tbody");
      table.appendChild(tbody);
      wrap.appendChild(table);

      function addRow(rowData) {
        const tr = document.createElement("tr");
        columns.forEach(col => {
          const key = col.key || col;
          const td = document.createElement("td");
          const input = createInput(rowData ? rowData[key] : "", col);
          input.dataset.key = key;
td.style.minWidth = col.multiline ? "360px" : "180px";
td.appendChild(input);

          tr.appendChild(td);
        });
        const tdAct = document.createElement("td");
        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "Supprimer";
        del.className = "btn secondary";
        del.onclick = () => tr.remove();
        tdAct.appendChild(del);
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
      }

      (rows || []).forEach(r => addRow(r));

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btn secondary";
      addBtn.textContent = "Ajouter une ligne";
      addBtn.onclick = () => addRow({});

      container.appendChild(wrap);
      container.appendChild(addBtn);

      return () => {
        const out = [];
        tbody.querySelectorAll("tr").forEach(tr => {
          const obj = {};
          let has = false;
          tr.querySelectorAll("input,textarea").forEach(inp => {
            const v = String(inp.value || "").trim();
            obj[inp.dataset.key] = v;
            if (v) has = true;
          });
          if (has) out.push(obj);
        });
        return out;
      };
    }

    function renderRowTable(container, rows, columns) {
      const wrap = document.createElement("div");
      wrap.className = "wide";
      const table = document.createElement("table");
      table.innerHTML = "<thead><tr>" + columns.map(c => "<th>" + c + "</th>").join("") + "<th></th></tr></thead>";
      const tbody = document.createElement("tbody");
      table.appendChild(tbody);
      wrap.appendChild(table);

      function addRow(rowData) {
        const tr = document.createElement("tr");
        columns.forEach((col, idx) => {
          const td = document.createElement("td");
          const input = createInput(rowData ? rowData[idx] : "", { multiline: false });
          input.dataset.idx = idx;
          input.style.minWidth = "160px";
          td.appendChild(input);
          tr.appendChild(td);
        });
        const tdAct = document.createElement("td");
        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "Supprimer";
        del.className = "btn secondary";
        del.onclick = () => tr.remove();
        tdAct.appendChild(del);
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
      }

      (rows || []).forEach(r => addRow(r));

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btn secondary";
      addBtn.textContent = "Ajouter une ligne";
      addBtn.onclick = () => addRow([]);

      container.appendChild(wrap);
      container.appendChild(addBtn);

      return () => {
        const out = [];
        tbody.querySelectorAll("tr").forEach(tr => {
          const row = [];
          let has = false;
          tr.querySelectorAll("input,textarea").forEach(inp => {
            const v = String(inp.value || "").trim();
            row[Number(inp.dataset.idx)] = v;
            if (v) has = true;
          });
          if (has) out.push(row);
        });
        return out;
      };
    }

    function renderGroupTable(container, groups, columns, groupLabel) {
      const collectFns = [];
      const list = document.createElement("div");
      list.style.display = "grid";
      // Plus d'espace entre les rubriques/catégories (évite l'effet "ça se chevauche")
      list.style.gap = "28px";

      function addGroup(group) {
        const card = document.createElement("div");
        card.style.border = "1px solid #e5e7eb";
        card.style.borderRadius = "14px";
        card.style.padding = "12px";
        card.style.background = "#fff";
        const title = document.createElement("input");
        title.type = "text";
        title.placeholder = groupLabel;
        title.value = group?.title || group?.name || "";
        title.style.marginBottom = "8px";
        title.style.width = "100%";
        card.appendChild(title);
        const collector = renderTable(card, group?.items || [], columns);
        list.appendChild(card);
        collectFns.push(() => {
          const t = String(title.value || "").trim();
          const items = collector();
          return t ? { title: t, items } : null;
        });
      }

      (groups || []).forEach(g => addGroup(g));

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btn secondary";
      addBtn.textContent = "Ajouter " + groupLabel;
      addBtn.onclick = () => addGroup({});

      container.appendChild(list);
      container.appendChild(addBtn);

      return () => collectFns.map(fn => fn()).filter(Boolean);
    }

    function renderEditorForKey(key, data) {
      editorArea.innerHTML = "";
      const entry = registry.find(r => r.key === key);
      const schema = schemas[entry?.editor || ""];
      if (entry?.editor === "fournisseurs_ramasse" && Array.isArray(data)) {
        data = data.map(r => ({
          ...r,
          recipients: Array.isArray(r.recipients) ? r.recipients.join(", ") : (r.recipients || ""),
          cc: Array.isArray(r.cc) ? r.cc.join(", ") : (r.cc || "")
        }));
      }
      if (entry?.editor === "retour_garantie_vl") {
        const mails = Array.isArray(data?.mailsRetour) ? data.mailsRetour : [];
        const contacts = Array.isArray(data?.contactsGarantie) ? data.contactsGarantie : [];
        const normMails = mails.map(m => {
          if (typeof m === "string") {
            const parts = m.split(":");
            return { fournisseur: (parts[0] || "").trim(), email: parts.slice(1).join(":").trim() };
          }
          return { fournisseur: m?.fournisseur || m?.label || "", email: m?.email || m?.mail || m?.value || "" };
        });
        const normContacts = contacts.map(c => ({
          fournisseur: c?.fournisseur || "",
          suivie: c?.contactSuivie || c?.contact_suivie || c?.suivie || c?.suivi || "",
          demande: c?.contactDemande || c?.contact_demande || c?.demande || "",
          commercial: c?.contactCommercial || c?.contact_commercial || c?.commercial || "",
          notes: c?.notes || c?.note || ""
        }));
        data = { mailsRetour: normMails, contactsGarantie: normContacts };
      }
      if (!schema) {
        editorArea.textContent = "Aucun formulaire défini pour ce JSON.";
        return () => data;
      }

      if (schema.type === "table") {
        return renderTable(editorArea, Array.isArray(data) ? data : [], schema.columns);
      }

      if (schema.type === "rowTable") {
        return renderRowTable(editorArea, Array.isArray(data) ? data : [], schema.columns);
      }

      if (schema.type === "multi") {
        const blockCollectors = [];
        (schema.blocks || []).forEach(block => {
          const section = document.createElement("div");
          // Plus d'air entre les blocs (VL: catégories/dépôts/back2car/hub)
          section.style.margin = "22px 0 34px";
          section.innerHTML = "<div style=\\"font-weight:700;margin-bottom:8px\\">" + block.label + "</div>";
          if (block.type === "table") {
            const collect = renderTable(section, data?.[block.key] || [], block.columns);
            blockCollectors.push(() => [block.key, collect()]);
          } else if (block.type === "group") {
            const collect = renderGroupTable(section, data?.[block.key] || [], block.columns, block.groupLabel);
            blockCollectors.push(() => [block.key, collect()]);
          }
          editorArea.appendChild(section);
        });
        return () => {
          const out = {};
          blockCollectors.forEach(fn => {
            const [k, v] = fn();
            out[k] = v;
          });
          return out;
        };
      }

      return () => data;
    }

    let collectForm = () => currentData;

    document.getElementById("btnLoad").addEventListener("click", async () => {
      setMsg("Chargement...", true);
      const key = sel.value;
      try {
        const r = await fetch(\`\${BASE}/api/load?key=\${encodeURIComponent(key)}\`, { cache: "no-store" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Erreur chargement");
        currentData = j.data;
        currentKey = key;
        collectForm = renderEditorForKey(key, j.data);
        area.value = JSON.stringify(j.data, null, 2);
        lastMod.textContent = j.lastModified || "—";
        setMsg("Chargé.", true);
      } catch (e) {
        setMsg(String(e.message || e), false);
      }
    });

    document.getElementById("btnSave").addEventListener("click", async () => {
      const key = sel.value;
      const entry = registry.find(r => r.key === key);
      const schema = schemas[entry?.editor || ""];
      let parsed = collectForm();

      if (schema && entry?.editor === "fournisseurs_ramasse") {
        parsed = (parsed || []).map(r => ({
          name: r.name || "",
          magasin: r.magasin || "",
          recipients: String(r.recipients || "")
            .split(/[;,]/).map(s => s.trim()).filter(Boolean),
          cc: String(r.cc || "")
            .split(/[;,]/).map(s => s.trim()).filter(Boolean),
          infoLivreur: r.infoLivreur || ""
        }));
      }

      area.value = JSON.stringify(parsed, null, 2);
      setMsg("Enregistrement...", true);
      try {
        const r = await fetch(\`\${BASE}/api/save\`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": CSRF
          },
          body: JSON.stringify({ key, data: parsed })
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Erreur sauvegarde");
        lastMod.textContent = j.lastModified || "—";
        setMsg("Enregistré.", true);
      } catch (e) {
        setMsg(String(e.message || e), false);
      }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION SPÉCIALE : Éditeur Kilométrage
    // ═══════════════════════════════════════════════════════════════════════
    const kmSection = document.createElement("div");
    kmSection.id = "kmSection";
    kmSection.style.display = "none";
    kmSection.innerHTML = `
      <div style="margin-top:18px">
        <h2 style="font-size:16px;margin:0 0 14px;color:#1e3a5f">📊 Données Kilométrage</h2>

        <!-- Filtres -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px;padding:14px;background:#f0f4ff;border-radius:12px;border:1px solid #c7d7f4">
          <div>
            <label style="font-size:12px;font-weight:700;color:#334155;display:block;margin-bottom:4px">📍 Magasin</label>
            <select id="kmAgence" style="width:100%"></select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:700;color:#334155;display:block;margin-bottom:4px">📅 Année</label>
            <select id="kmYear" style="width:100%"></select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:700;color:#334155;display:block;margin-bottom:4px">🗓️ Mois</label>
            <select id="kmMonth" style="width:100%">
              <option value="">— Tous —</option>
              <option value="01">Janvier</option><option value="02">Février</option>
              <option value="03">Mars</option><option value="04">Avril</option>
              <option value="05">Mai</option><option value="06">Juin</option>
              <option value="07">Juillet</option><option value="08">Août</option>
              <option value="09">Septembre</option><option value="10">Octobre</option>
              <option value="11">Novembre</option><option value="12">Décembre</option>
            </select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:700;color:#334155;display:block;margin-bottom:4px">🚚 Tournée</label>
            <select id="kmTournee" style="width:100%"><option value="">— Toutes —</option></select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:700;color:#334155;display:block;margin-bottom:4px">📆 Jour</label>
            <input id="kmDay" type="number" min="1" max="31" placeholder="1-31" style="width:100%">
          </div>
        </div>

        <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
          <button class="btn" id="btnKmLoad" type="button">🔍 Charger</button>
          <button class="btn secondary" id="btnKmRefresh" type="button" style="display:none">🔄 Réinitialiser filtres</button>
          <span id="kmMsg" style="font-weight:700;font-size:13px"></span>
        </div>

        <div id="kmResults" style="display:none">
          <!-- Stats bar -->
          <div id="kmStats" style="padding:10px 14px;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:10px;margin-bottom:12px;font-size:13px;font-weight:600;color:#065f46"></div>

          <!-- Table -->
          <div style="overflow-x:auto;border:1px solid #e5e7eb;border-radius:12px">
            <table id="kmTable" style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr style="background:#1e3a5f;color:#fff">
                  <th style="padding:10px 8px;text-align:left;white-space:nowrap">Date</th>
                  <th style="padding:10px 8px;text-align:left;white-space:nowrap">Tournée</th>
                  <th style="padding:10px 8px;text-align:left;white-space:nowrap">Chauffeur</th>
                  <th style="padding:10px 8px;text-align:left;white-space:nowrap">Type</th>
                  <th style="padding:10px 8px;text-align:right;white-space:nowrap">8h</th>
                  <th style="padding:10px 8px;text-align:right;white-space:nowrap">12h</th>
                  <th style="padding:10px 8px;text-align:right;white-space:nowrap">14h</th>
                  <th style="padding:10px 8px;text-align:right;white-space:nowrap">18h</th>
                  <th style="padding:10px 8px;text-align:left">Commentaire</th>
                  <th style="padding:10px 8px;text-align:center;white-space:nowrap">Actions</th>
                </tr>
              </thead>
              <tbody id="kmTbody"></tbody>
            </table>
          </div>
          <div style="margin-top:12px;display:flex;gap:10px;justify-content:flex-end">
            <button class="btn" id="btnKmSave" type="button">💾 Enregistrer les modifications</button>
          </div>
        </div>

        <!-- Modal edit -->
        <div id="kmModal" style="display:none;position:fixed;inset:0;background:#0008;z-index:9999;align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:14px;padding:22px;width:min(480px,94vw);max-height:90vh;overflow:auto;box-shadow:0 20px 60px #0004">
            <h3 style="margin:0 0 16px;color:#1e3a5f;font-size:15px" id="kmModalTitle">Modifier le relevé</h3>
            <div id="kmModalBody"></div>
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
              <button class="btn secondary" id="btnKmModalCancel" type="button">Annuler</button>
              <button class="btn" id="btnKmModalSave" type="button">💾 Appliquer</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.querySelector(".wrap").appendChild(kmSection);

    // ── State ──
    let kmAllData   = {}; // { "GLEIZE/2026-02": [...records] }
    let kmAgences   = [];
    let kmMonthsMap = {}; // { "GLEIZE": ["2026-01","2026-02",...] }
    let kmEditTarget = null; // { agence, yearMonth, recordIdx }

    function setKmMsg(t, ok) {
      const el = document.getElementById("kmMsg");
      if (el) { el.textContent = t || ""; el.style.color = ok ? "green" : "crimson"; }
    }

    // Populate agence selector and year from available months
    async function kmInitSelectors() {
      const agenceSel = document.getElementById("kmAgence");
      const yearSel   = document.getElementById("kmYear");
      setKmMsg("Chargement des magasins...", true);
      try {
        const r = await fetch(\`\${BASE}/api/km-agences\`, { cache: "no-store" });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error);

        kmAgences = j.agences;
        kmMonthsMap = j.monthsMap;

        agenceSel.innerHTML = "";
        kmAgences.forEach(ag => {
          const o = document.createElement("option");
          o.value = ag;
          o.textContent = ag;
          agenceSel.appendChild(o);
        });

        // Build year list from all months
        const years = new Set();
        Object.values(j.monthsMap).forEach(months => {
          months.forEach(m => years.add(m.slice(0,4)));
        });
        yearSel.innerHTML = '<option value="">— Toutes —</option>';
        [...years].sort().reverse().forEach(y => {
          const o = document.createElement("option");
          o.value = y; o.textContent = y;
          yearSel.appendChild(o);
        });
        // Select current year by default
        const curYear = new String(new Date().getFullYear());
        [...yearSel.options].forEach(o => { if (o.value === curYear) o.selected = true; });

        setKmMsg("", true);
      } catch(e) {
        setKmMsg("Erreur chargement magasins: " + e.message, false);
      }
    }

    // Load records for the selected agence + filter
    document.getElementById("btnKmLoad").addEventListener("click", async () => {
      const agence  = document.getElementById("kmAgence").value;
      const year    = document.getElementById("kmYear").value;
      const month   = document.getElementById("kmMonth").value;
      const tournee = document.getElementById("kmTournee").value;
      const day     = document.getElementById("kmDay").value.trim();

      if (!agence) { setKmMsg("Sélectionnez un magasin.", false); return; }

      setKmMsg("Chargement...", true);
      document.getElementById("kmResults").style.display = "none";

      try {
        // Determine which months to load
        const allMonths = kmMonthsMap[agence] || [];
        let monthsToLoad = allMonths;
        if (year && month) monthsToLoad = [`${year}-${month}`].filter(m => allMonths.includes(m));
        else if (year)  monthsToLoad = allMonths.filter(m => m.startsWith(year));
        else if (month) monthsToLoad = allMonths.filter(m => m.endsWith(`-${month}`));

        if (monthsToLoad.length === 0) {
          setKmMsg("Aucun fichier trouvé pour ces filtres.", false);
          return;
        }

        // Load all needed months
        const fetches = monthsToLoad.map(ym =>
          fetch(\`\${BASE}/api/km-data?agence=\${encodeURIComponent(agence)}&yearMonth=\${ym}\`, { cache: "no-store" })
            .then(r => r.json())
            .then(j => j.ok ? j.records : [])
            .catch(() => [])
        );
        const results = await Promise.all(fetches);
        // Merge into kmAllData
        monthsToLoad.forEach((ym, i) => {
          kmAllData[\`\${agence}/\${ym}\`] = results[i] || [];
        });

        // Build unified list
        let allRecs = monthsToLoad.flatMap(ym => (kmAllData[\`\${agence}/\${ym}\`] || []).map(r => ({ ...r, _ym: ym })));

        // Apply filters
        if (tournee) allRecs = allRecs.filter(r => (r.tournee || "") === tournee);
        if (day)     allRecs = allRecs.filter(r => {
          const d = parseInt(String(r.date || "").slice(8,10), 10);
          return d === parseInt(day, 10);
        });

        // Update tournée selector
        const tourneeSet = new Set(monthsToLoad.flatMap(ym => (kmAllData[\`\${agence}/\${ym}\`] || []).map(r => r.tournee || "")));
        const tourneeSel = document.getElementById("kmTournee");
        const prevTournee = tourneeSel.value;
        tourneeSel.innerHTML = '<option value="">— Toutes —</option>';
        [...tourneeSet].filter(Boolean).sort().forEach(t => {
          const o = document.createElement("option");
          o.value = t; o.textContent = t;
          if (t === prevTournee) o.selected = true;
          tourneeSel.appendChild(o);
        });

        // Group by date+tournee for display
        kmRenderTable(allRecs, agence);
        document.getElementById("btnKmRefresh").style.display = "";
        setKmMsg(`${allRecs.length} relevé(s) chargé(s).`, true);
        document.getElementById("kmResults").style.display = "";
      } catch(e) {
        setKmMsg("Erreur: " + e.message, false);
      }
    });

    document.getElementById("btnKmRefresh").addEventListener("click", () => {
      document.getElementById("kmTournee").value = "";
      document.getElementById("kmDay").value = "";
      document.getElementById("kmResults").style.display = "none";
      setKmMsg("", true);
    });

    // ── Render table ──────────────────────────────────────────────────────
    function kmFmtDate(d) {
      if (!d) return "—";
      const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
    }

    function kmRenderTable(records, agence) {
      const tbody = document.getElementById("kmTbody");
      const stats = document.getElementById("kmStats");
      tbody.innerHTML = "";

      if (records.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="padding:20px;text-align:center;color:#6b7280">Aucune donnée pour ces filtres.</td></tr>';
        stats.textContent = "Aucun relevé.";
        return;
      }

      // Group by date + tournee
      const grouped = {};
      records.forEach(r => {
        const key = `${r.date}||${r.tournee}`;
        if (!grouped[key]) grouped[key] = { date: r.date, tournee: r.tournee, chauffeur: r.chauffeur, type: r.type, _ym: r._ym, horaires: {} };
        if (r.horaire) grouped[key].horaires[r.horaire] = r;
        else if (r.type === "absence") grouped[key].absence = r;
      });

      const keys = Object.keys(grouped).sort((a, b) => a < b ? -1 : 1);
      let totalReleves = 0, totalAbsences = 0;

      keys.forEach(k => {
        const g = grouped[k];
        const isAbsence = g.type === "absence" || !!g.absence;
        if (isAbsence) totalAbsences++; else totalReleves++;

        const tr = document.createElement("tr");
        tr.style.borderBottom = "1px solid #f0f0f0";
        tr.style.background = isAbsence ? "#fff7ed" : "#fff";

        // Helper: km cell
        function kmCell(horaire) {
          const rec = g.horaires[horaire];
          const km = rec ? rec.km : null;
          return `<td style="padding:8px;text-align:right;min-width:80px">
            ${km !== null && km !== undefined ? `<span style="font-weight:600">${km.toLocaleString("fr-FR")}</span>` : '<span style="color:#d1d5db">—</span>'}
          </td>`;
        }

        tr.innerHTML = `
          <td style="padding:8px;white-space:nowrap;font-weight:600">${kmFmtDate(g.date)}</td>
          <td style="padding:8px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${g.tournee || ""}">${g.tournee || "—"}</td>
          <td style="padding:8px;white-space:nowrap;color:#4b5563">${g.chauffeur || "—"}</td>
          <td style="padding:8px;white-space:nowrap">
            ${isAbsence
              ? '<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700">ABSENT</span>'
              : '<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700">Relevé</span>'}
          </td>
          ${kmCell("8h")}${kmCell("12h")}${kmCell("14h")}${kmCell("18h")}
          <td style="padding:8px;max-width:140px;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:#6b7280">
            ${g.horaires["8h"]?.commentaire || g.absence?.note || ""}
          </td>
          <td style="padding:8px;text-align:center;white-space:nowrap">
            <button type="button" class="btn" onclick="kmEditGroup(${JSON.stringify(JSON.stringify(g))})"
              style="padding:5px 10px;font-size:11px;margin-right:4px">✏️ Modifier</button>
            <button type="button" class="btn danger" onclick="kmDeleteGroup(${JSON.stringify(JSON.stringify(g))})"
              style="padding:5px 10px;font-size:11px">🗑️ Jour</button>
          </td>
        `;
        tbody.appendChild(tr);
      });

      stats.innerHTML = `<b>${keys.length}</b> ligne(s) • <b>${totalReleves}</b> relevé(s) • <b>${totalAbsences}</b> absence(s) • Magasin : <b>${agence}</b>`;
    }

    // ── Edit a group (date+tournee) ────────────────────────────────────────
    window.kmEditGroup = function(gJson) {
      const g = JSON.parse(gJson);
      const agence = document.getElementById("kmAgence").value;
      const modal = document.getElementById("kmModal");
      const body  = document.getElementById("kmModalBody");
      document.getElementById("kmModalTitle").textContent = `Modifier — ${kmFmtDate(g.date)} — ${g.tournee}`;
      kmEditTarget = { g, agence };

      if (g.type === "absence" || g.absence) {
        const note = g.absence?.note || "";
        body.innerHTML = `
          <div style="background:#fff7ed;border:1px solid #fbbf24;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px">
            ⚠️ Ce relevé est une <b>absence</b>.
          </div>
          <label style="font-weight:700;font-size:13px;display:block;margin-bottom:4px">Note / Commentaire</label>
          <textarea id="kmEditNote" rows="3" style="width:100%;border:1px solid #d1d5db;border-radius:8px;padding:8px;font-size:13px">${note}</textarea>
        `;
      } else {
        const horaires = ["8h","12h","14h","18h"];
        let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">';
        horaires.forEach(h => {
          const rec = g.horaires[h];
          const km  = rec ? rec.km : "";
          const com = rec ? (rec.commentaire || "") : "";
          html += `
            <div style="background:#f8faff;border:1px solid #e0e7ff;border-radius:10px;padding:12px">
              <div style="font-weight:800;font-size:13px;color:#1e3a5f;margin-bottom:8px">⏰ ${h}</div>
              <label style="font-size:11px;font-weight:700;display:block;margin-bottom:2px">Kilométrage</label>
              <input id="kmKm_${h}" type="number" value="${km}" placeholder="—"
                style="width:100%;border:1px solid #d1d5db;border-radius:6px;padding:6px;font-size:13px;margin-bottom:6px">
              <label style="font-size:11px;font-weight:700;display:block;margin-bottom:2px">Commentaire</label>
              <input id="kmCom_${h}" type="text" value="${com}" placeholder=""
                style="width:100%;border:1px solid #d1d5db;border-radius:6px;padding:6px;font-size:13px">
            </div>
          `;
        });
        html += `</div>`;
        body.innerHTML = html;
      }

      modal.style.display = "flex";
    };

    document.getElementById("btnKmModalCancel").addEventListener("click", () => {
      document.getElementById("kmModal").style.display = "none";
      kmEditTarget = null;
    });
    document.getElementById("kmModal").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) {
        document.getElementById("kmModal").style.display = "none";
        kmEditTarget = null;
      }
    });

    document.getElementById("btnKmModalSave").addEventListener("click", async () => {
      if (!kmEditTarget) return;
      const { g, agence } = kmEditTarget;
      const ym = g._ym;
      const key = `${agence}/${ym}`;
      let records = (kmAllData[key] || []).map(r => ({...r}));

      setKmMsg("Enregistrement...", true);
      try {
        if (g.type === "absence" || g.absence) {
          // Update note for absence record matching date+tournee
          const note = document.getElementById("kmEditNote")?.value || "";
          records = records.map(r => {
            if (r.date === g.date && r.tournee === g.tournee && r.type === "absence") {
              return { ...r, note };
            }
            return r;
          });
        } else {
          const horaires = ["8h","12h","14h","18h"];
          horaires.forEach(h => {
            const kmVal = document.getElementById(`kmKm_${h}`)?.value;
            const com   = document.getElementById(`kmCom_${h}`)?.value || "";
            const existingIdx = records.findIndex(r => r.date === g.date && r.tournee === g.tournee && r.horaire === h);
            if (kmVal !== "" && kmVal !== undefined && kmVal !== null) {
              const km = parseInt(kmVal, 10);
              if (!isNaN(km)) {
                if (existingIdx >= 0) {
                  records[existingIdx] = { ...records[existingIdx], km, commentaire: com };
                } else {
                  // Add new record for this horaire
                  const template = g.horaires[Object.keys(g.horaires)[0]];
                  records.push({
                    type: "releve", id: template?.id || null,
                    agence: template?.agence || agence, codeAgence: template?.codeAgence || agence,
                    tournee: g.tournee, codeTournee: template?.codeTournee || "",
                    chauffeur: g.chauffeur, codeChauffeur: template?.codeChauffeur || g.chauffeur,
                    date: g.date, km, horaire: h, commentaire: com, note: "",
                    createdAt: new Date().toISOString()
                  });
                }
              }
            } else if (kmVal === "" && existingIdx >= 0) {
              // Empty field = remove this horaire record
              records.splice(existingIdx, 1);
            }
          });
        }

        // Save
        const resp = await fetch(\`\${BASE}/api/km-save\`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-csrf-token": CSRF },
          body: JSON.stringify({ agence, yearMonth: ym, records })
        });
        const j = await resp.json();
        if (!j.ok) throw new Error(j.error || "Erreur sauvegarde");

        kmAllData[key] = records;
        setKmMsg("Enregistré ✓", true);
        document.getElementById("kmModal").style.display = "none";
        kmEditTarget = null;
        // Reload display
        document.getElementById("btnKmLoad").click();
      } catch(e) {
        setKmMsg("Erreur: " + e.message, false);
      }
    });

    // ── Delete an entire day+tournee group ────────────────────────────────
    window.kmDeleteGroup = function(gJson) {
      const g = JSON.parse(gJson);
      const agence = document.getElementById("kmAgence").value;
      const label = `${kmFmtDate(g.date)} — ${g.tournee}`;
      if (!confirm(\`⚠️ Supprimer TOUTES les données du :\n\n\${label}\n\nCette action est irréversible.\`)) return;

      const ym  = g._ym;
      const key = \`\${agence}/\${ym}\`;
      let records = (kmAllData[key] || []).map(r => ({...r}));
      // Remove all records matching date + tournee
      records = records.filter(r => !(r.date === g.date && r.tournee === g.tournee));
      kmAllData[key] = records;

      // Save immediately
      setKmMsg("Suppression...", true);
      fetch(\`\${BASE}/api/km-save\`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": CSRF },
        body: JSON.stringify({ agence, yearMonth: ym, records })
      }).then(r => r.json()).then(j => {
        if (!j.ok) throw new Error(j.error);
        setKmMsg("Supprimé ✓", true);
        document.getElementById("btnKmLoad").click();
      }).catch(e => setKmMsg("Erreur: " + e.message, false));
    };

    // ── Bulk save (for manual save button) ──────────────────────────────
    document.getElementById("btnKmSave").addEventListener("click", async () => {
      setKmMsg("Enregistrement...", true);
      let ok = 0, err = 0;
      for (const [key, records] of Object.entries(kmAllData)) {
        const [agence, yearMonth] = key.split("/");
        try {
          const resp = await fetch(\`\${BASE}/api/km-save\`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-csrf-token": CSRF },
            body: JSON.stringify({ agence, yearMonth, records })
          });
          const j = await resp.json();
          if (!j.ok) throw new Error(j.error);
          ok++;
        } catch(e) { err++; }
      }
      setKmMsg(err ? \`Enregistré avec \${err} erreur(s)\` : \`Enregistré (\${ok} fichier(s)) ✓\`, err === 0);
    });

    // ── Show/hide km section based on key selection ──────────────────────
    const _origBtnLoad = document.getElementById("btnLoad");
    const _origEditorArea = document.getElementById("editorArea");
    const _origJsonArea   = document.querySelector("details");
    const _origSaveBar    = _origBtnLoad?.closest(".card")?.querySelector("#btnSave")?.parentElement;

    sel.addEventListener("change", () => {
      const entry = registry.find(r => r.key === sel.value);
      const isKm = entry?._special === "km-editor";
      kmSection.style.display = isKm ? "" : "none";
      if (_origEditorArea) _origEditorArea.style.display = isKm ? "none" : "";
      const details = document.querySelector("details");
      if (details) details.style.display = isKm ? "none" : "";
      const saveBtnRow = document.querySelector("#btnSave")?.closest(".row");
      if (saveBtnRow) saveBtnRow.style.display = isKm ? "none" : "";
      const loadBtnRow = document.querySelector("#btnLoad")?.closest(".row");
      if (loadBtnRow) loadBtnRow.style.display = isKm ? "none" : "";
      if (isKm) kmInitSelectors();
    });
  </script>
  `);
}

function setupPage(qrDataUrl, secret, csrfToken) {
  return htmlPage("Setup 2FA", `
  <div class="card">
    <h1>Configuration 2FA</h1>
    <p>Scannez le QR code dans Google Authenticator, puis saisissez le code.</p>
    <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
      <img src="${qrDataUrl}" alt="QR Code" width="220" height="220"/>
      <div>
        <div class="muted">Secret (si besoin): <code>${secret}</code></div>
      </div>
    </div>
    <form method="POST" action="./setup/verify" style="margin-top:16px">
      <input type="hidden" name="csrfToken" value="${csrfToken}"/>
      <label>Code TOTP</label>
      <input name="code" inputmode="numeric" autocomplete="one-time-code" required />
      <button class="btn" style="margin-top:12px" type="submit">Vérifier</button>
    </form>
  </div>`);
}

function loginPage(csrfToken) {
  return htmlPage("Login 2FA", `
  <div class="card">
    <h1>Connexion</h1>
    <p>Saisissez un code TOTP ou un backup code.</p>
    <form method="POST" action="./login">
      <input type="hidden" name="csrfToken" value="${csrfToken}"/>
      <label>Code</label>
      <input name="code" autocomplete="one-time-code" required />
      <button class="btn" style="margin-top:12px" type="submit">Se connecter</button>
    </form>
  </div>`);
}

function backupCodesPage(codes, baseUrl) {
  const list = codes.map(c => `<li><code>${c}</code></li>`).join("");
  return htmlPage("Backup Codes", `
  <div class="card">
    <h1>Backup codes</h1>
    <p>Conservez ces codes en lieu sûr. Ils ne seront affichés qu'une seule fois.</p>
    <ul>${list}</ul>
    <form method="POST" action="${baseUrl}/logout">
      <button class="btn danger" type="submit">Fermer</button>
    </form>
  </div>`);
}

export default function createAdminEditorRouter() {
  const router = express.Router();
  const basePath = String(process.env.ADMIN_EDITOR_PATH || "").trim();
  if (!basePath) {
    console.warn("[ADMIN] ADMIN_EDITOR_PATH manquant, routes admin non activées.");
    return router;
  }

  const limiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.use(express.urlencoded({ extended: true }));

  router.get(`/${basePath}`, async (req, res) => {
    if (!req.session?.adminAuthed) return res.redirect(`/${basePath}/login`);
    const token = ensureCsrf(req);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(editorPage(`/${basePath}`, token));
  });

  router.get(`/${basePath}/setup`, limiter, async (req, res) => {
    const existing = await loadAuth().catch(() => null);
    if (existing?.enabled) return res.redirect(`/${basePath}/login`);
    if (!req.session.setupSecret) {
      req.session.setupSecret = generateTotpSecret();
    }
    const secret = req.session.setupSecret;
    const otpauth = buildOtpAuthUrl(secret);
    const qrDataUrl = await qrcode.toDataURL(otpauth);
    const token = ensureCsrf(req);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(setupPage(qrDataUrl, secret, token));
  });

  router.post(`/${basePath}/setup/verify`, limiter, async (req, res) => {
    const token = ensureCsrf(req);
    if (req.body?.csrfToken !== token) {
      return res.status(403).send("CSRF invalide");
    }
    const existing = await loadAuth().catch(() => null);
    if (existing?.enabled) return res.redirect(`/${basePath}/login`);
    const secret = req.session.setupSecret;
    const code = String(req.body?.code || "").trim();
    if (!secret || !verifyTotp(secret, code)) {
      return res.status(400).send("Code invalide");
    }
    const { codes, hashed } = makeBackupCodes(10);
    await saveAuth({
      enabled: true,
      createdAt: new Date().toISOString(),
      totpSecret: secret,
      backupCodes: hashed,
    });
    req.session.adminAuthed = true;
    req.session.setupSecret = null;
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(backupCodesPage(codes, `/${basePath}`));
  });

  router.get(`/${basePath}/login`, limiter, async (req, res) => {
    const auth = await loadAuth().catch(() => null);
    if (!auth?.enabled) return res.redirect(`/${basePath}/setup`);
    if (req.session?.adminAuthed) return res.redirect(`/${basePath}`);
    const token = ensureCsrf(req);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(loginPage(token));
  });

  router.post(`/${basePath}/login`, limiter, async (req, res) => {
    const token = ensureCsrf(req);
    if (req.body?.csrfToken !== token) {
      return res.status(403).send("CSRF invalide");
    }
    const auth = await loadAuth().catch(() => null);
    if (!auth?.enabled) return res.redirect(`/${basePath}/setup`);

    const code = String(req.body?.code || "").trim();
    const okTotp = verifyTotp(auth.totpSecret, code);
    let okBackup = false;
    if (!okTotp && Array.isArray(auth.backupCodes)) {
      okBackup = consumeBackupCode(auth.backupCodes, code);
      if (okBackup) await saveAuth(auth);
    }

    if (!okTotp && !okBackup) {
      return res.status(401).send("Code invalide");
    }

    req.session.adminAuthed = true;
    return res.redirect(`/${basePath}`);
  });

  router.post(`/${basePath}/logout`, requireCsrf, (req, res) => {
    req.session.adminAuthed = false;
    return res.redirect(`/${basePath}/login`);
  });

  router.get(`/${basePath}/api/load`, requireAuth, async (req, res) => {
    const key = String(req.query?.key || "").trim();
    const entry = resolveJsonEntry(key);
    if (!entry) return res.status(404).json({ ok: false, error: "unknown_key" });
    try {
      let data = await ftpStorage.readJson(entry.filename);
      if (data == null) {
        const seedMap = {
          "fournisseur-pl": seedFournisseurPl,
          "site-identification-oe": seedSiteIdentificationOe,
          "fournisseur-vl": seedFournisseurVl,
        };
        const seedFn = seedMap[key];
        if (seedFn) {
          data = await seedFn();
          if (data != null) {
            try { await ftpStorage.writeJson(entry.filename, data, { backup: false }); } catch {}
          }
        }
      }
      if (data == null) return res.status(404).json({ ok: false, error: "file_not_found" });
      const lastModified = await ftpStorage.getModifiedAt(entry.filename);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ok: true, data, lastModified, filename: entry.filename });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ── Km API routes ──────────────────────────────────────────────────────

  router.get(`/${basePath}/api/km-agences`, requireAuth, async (req, res) => {
    try {
      const agences = await kmListAgences();
      const monthsMap = {};
      for (const ag of agences) {
        try {
          monthsMap[ag] = await kmListMonths(ag);
        } catch { monthsMap[ag] = []; }
      }
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ok: true, agences, monthsMap });
    } catch(e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  router.get(`/${basePath}/api/km-data`, requireAuth, async (req, res) => {
    const agence    = String(req.query.agence    || "").trim();
    const yearMonth = String(req.query.yearMonth || "").trim();
    if (!agence || !yearMonth) {
      return res.status(400).json({ ok: false, error: "agence et yearMonth requis" });
    }
    try {
      const remote  = kmMonthPath(agence, yearMonth);
      const data    = await kmReadJson(remote);
      const records = Array.isArray(data) ? data : [];
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ok: true, records, agence, yearMonth });
    } catch(e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  router.post(`/${basePath}/api/km-save`, requireAuth, requireCsrf, express.json({ limit: "4mb" }), async (req, res) => {
    const agence    = String(req.body?.agence    || "").trim();
    const yearMonth = String(req.body?.yearMonth || "").trim();
    const records   = req.body?.records;
    if (!agence || !yearMonth) {
      return res.status(400).json({ ok: false, error: "agence et yearMonth requis" });
    }
    if (!Array.isArray(records)) {
      return res.status(400).json({ ok: false, error: "records doit être un tableau" });
    }
    // Validate yearMonth format
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
      return res.status(400).json({ ok: false, error: "yearMonth format invalide (YYYY-MM)" });
    }
    try {
      const remote = kmMonthPath(agence, yearMonth);
      await kmWriteJson(remote, records);
      return res.json({ ok: true, agence, yearMonth, count: records.length });
    } catch(e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ── Fin km API routes ───────────────────────────────────────────────────

  router.post(`/${basePath}/api/save`, requireAuth, requireCsrf, express.json({ limit: "2mb" }), async (req, res) => {
    const key = String(req.body?.key || "").trim();
    const entry = resolveJsonEntry(key);
    if (!entry) return res.status(404).json({ ok: false, error: "unknown_key" });
    const data = req.body?.data;
    if (data === undefined) {
      return res.status(400).json({ ok: false, error: "missing_data" });
    }
    try {
      await ftpStorage.writeJson(entry.filename, data, { backup: false });
      const lastModified = await ftpStorage.getModifiedAt(entry.filename);
      return res.json({ ok: true, lastModified });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return router;
}
