import express from "express";
import rateLimit from "express-rate-limit";
import qrcode from "qrcode";
import crypto from "crypto";

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
  const registryJson = JSON.stringify(registry);
  return htmlPage("Editeur JSON", `
  <div class="card">
    <h1>Editeur JSON</h1>
    <div class="muted">Accès protégé 2FA. Dernière modification affichée après chargement.</div>
    <label for="pageKey">Choisir la page à modifier</label>
    <select id="pageKey"></select>
    <div class="row" style="margin-top:12px">
      <button class="btn" id="btnLoad" type="button">Charger</button>
      <button class="btn" id="btnSave" type="button">Enregistrer</button>
    </div>
    <div id="editorArea" class="grid" style="margin-top:14px"></div>
    <details style="margin-top:12px">
      <summary class="muted" style="cursor:pointer">JSON brut (avancé)</summary>
      <textarea id="jsonArea" spellcheck="false" style="margin-top:8px"></textarea>
    </details>
    <div class="row" style="margin-top:10px">
      <div class="muted">Dernière modification: <span id="lastMod">—</span></div>
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
    const entry = getByKey(key);
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

  router.post(`/${basePath}/api/save`, requireAuth, requireCsrf, express.json({ limit: "2mb" }), async (req, res) => {
    const key = String(req.body?.key || "").trim();
    const entry = getByKey(key);
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
