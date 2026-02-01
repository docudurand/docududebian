// routes API pour la demande de ramasse (PDF + emails + ack)

import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";

import mime from "mime-types";
import PDFDocument from "pdfkit";
import ftp from "basic-ftp";
import { fileURLToPath } from "url";
import { incrementRamasseMagasin, getCompteurs } from "../compteur.js";
import { transporter, fromEmail } from "../mailer.js";
import { sendMailWithLog } from "../mailLog.js";

// Chemins utilitaires
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// routeur Express separe
const router = express.Router();
router.use(express.urlencoded({ extended: true }));

// Dossier temporaire pour les PDFs et uploads
const TMP_DIR = path.resolve(process.cwd(), "tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });

// liste CSV en tableau
function parseCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

// Filtres optionnels de fichiers uploades
const UPLOAD_ALLOWED_MIME = parseCsv(process.env.RAMASSE_UPLOAD_ALLOWED_MIME);
const UPLOAD_ALLOWED_EXT = parseCsv(process.env.RAMASSE_UPLOAD_ALLOWED_EXT);

// secret pour signer les liens d'accuse
const RAMASSE_SECRET =
  process.env.RAMASSE_SECRET ||
  process.env.PRESENCES_LEAVES_PASSWORD ||
  process.env.LEAVES_PASS ||
  "change-me";

// Emplacements possibles des JSON
const FOURNISSEUR_PATHS = [
  path.resolve(__dirname, "fournisseur.json"),
  path.resolve(__dirname, "../fournisseur.json"),
];
const MAGASINS_PATHS = [
  path.resolve(__dirname, "magasins.json"),
  path.resolve(__dirname, "../magasins.json"),
];

// Dedoublonnage des envois
const RECENT_POST_RAMASSE = new Map();
const RAMASSE_DEDUP_WINDOW_MS = 120_000;

// Verifie si la requete est un doublon recent
function isDuplicateRamasse(requestId) {
  const id = String(requestId || "").trim();
  if (!id) return false;
  const now = Date.now();

  for (const [k, ts] of RECENT_POST_RAMASSE.entries()) {
    if (now - ts > RAMASSE_DEDUP_WINDOW_MS) RECENT_POST_RAMASSE.delete(k);
  }

  const last = RECENT_POST_RAMASSE.get(id);
  if (last && (now - last) < RAMASSE_DEDUP_WINDOW_MS) return true;

  RECENT_POST_RAMASSE.set(id, now);
  return false;
}

// Gestion upload fichier (piece jointe)
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename: (_req, file, cb) => {
      const ext  = path.extname(file.originalname) || ".bin";
      const base = path
        .basename(file.originalname, ext)
        .replace(/[^a-z0-9-_]+/gi, "_");
      cb(null, `${Date.now()}_${base}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    if (!UPLOAD_ALLOWED_MIME.length && !UPLOAD_ALLOWED_EXT.length) {
      return cb(null, true);
    }
    const mimeType = String(file.mimetype || "").toLowerCase();
    const ext = path.extname(file.originalname || "").toLowerCase();
    const okMime = !UPLOAD_ALLOWED_MIME.length || UPLOAD_ALLOWED_MIME.includes(mimeType);
    const okExt = !UPLOAD_ALLOWED_EXT.length || (ext && UPLOAD_ALLOWED_EXT.includes(ext));
    if (!okMime || !okExt) {
      req.fileValidationError = "file_type_not_allowed";
      return cb(null, false);
    }
    return cb(null, true);
  },
  limits: { fileSize: 24 * 1024 * 1024 },
});

// Charge un JSON depuis une liste de chemins
function loadJsonFrom(paths, fallback) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf8");
        return JSON.parse(raw);
      }
    } catch {
    }
  }
  return fallback;
}

// Fournisseurs definis en variable d'env (optionnel)
let ENV_FOURNISSEURS;
(() => {
  const raw = process.env.FOURNISSEUR_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        ENV_FOURNISSEURS = parsed;
        console.log("[CONF] Liste des fournisseurs chargée via l'env FOURNISSEUR_JSON (" + parsed.length + ")");
      }
    } catch (err) {
      console.warn("[CONF] Impossible de parser FOURNISSEUR_JSON :", err && err.message ? err.message : err);
    }
  }
})();

// Liste des fournisseurs (env ou fichier)
function loadFournisseurs() {
  if (Array.isArray(ENV_FOURNISSEURS)) {
    return ENV_FOURNISSEURS;
  }
  const arr = loadJsonFrom(FOURNISSEUR_PATHS, []);
  return Array.isArray(arr) ? arr : [];
}

// Liste des magasins deduite des fournisseurs
function loadMagasins() {
  const data = loadJsonFrom(MAGASINS_PATHS, []);
  if (Array.isArray(data) && data.length) {
    return Array.from(
      new Set(
        data
          .map(x => (typeof x === "string" ? x : (x?.name || "")))
          .filter(Boolean)
      )
    );
  }
  const set = new Set();
  for (const f of loadFournisseurs()) {
    if (f.magasin) set.add(String(f.magasin));
  }
  return Array.from(set);
}

// Recherche un fournisseur par nom
function findFournisseur(name) {
  const list = loadFournisseurs();
  const n = String(name || "").trim().toLowerCase();
  return list.find(
    s => String(s.name || "").trim().toLowerCase() === n
  );
}

// Validation email simple
function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());
}

// Nettoie et dedoublonne une liste d'emails
function uniqEmails(arr) {
  const flat = [];

  for (const x of arr || []) {
    String(x || "")
      .split(/[;,]/)
      .map(s => s.trim())
      .filter(Boolean)
      .forEach(e => flat.push(e));
  }

  return Array.from(new Set(flat.filter(isValidEmail)));
}

// HTML non exécuté
function esc(t = "") {
  return String(t).replace(/[&<>"']/g, c =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c])
  );
}

// Force une seule ligne (utile pour PDF)
function oneLine(s) {
  return (
    String(s ?? "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim() || "—"
  );
}

// Date/heure Paris pour le PDF
function formatParisNow() {
  const d = new Date();
  const dateStr = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
  const time24 = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  const timeStr = time24.replace(":", "H");
  return { dateStr, timeStr };
}

// Genere le PDF de demande de ramasse
async function buildPdf({
  fournisseur,
  magasinDest,
  email,
  pieces,
  commentaire,
  demandeurNomPrenom,
  infoLivreur,
}) {
  const safe = s => String(s || "").replace(/[^a-z0-9-_]+/gi, "_");
  const pdfPath = path.join(
    TMP_DIR,
    `Demande_Ramasse_${safe(fournisseur)}_${Date.now()}.pdf`
  );
  const doc = new PDFDocument({ size: "A4", margin: 56 });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  const blue = "#0f4c81";
  const gray = "#102a43";

  const TITLE_FS   = 24;
  const SECTION_FS = 14;
  const LABEL_FS   = 12;
  const VALUE_FS   = 12;
  const COMMENT_FS = 12;

  const pageLeft  = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;

  const GAP_AFTER_TITLE    = 28;
  const GAP_AFTER_INFO_HDR = 22;
  const ROW_GAP            = 24;
  const COMMENT_TOP_GAP    = 14;
  const COMMENT_LINE_GAP   = 3;

  try {
    const resp = await fetch(
      "https://raw.githubusercontent.com/docudurand/mes-formulaires/main/logodurand.png"
    );
    const buf = Buffer.from(await resp.arrayBuffer());
    doc.image(buf, pageLeft, 36, { width: 90 });
  } catch {
  }

  const titleY = 140;
  doc
    .font("Helvetica-Bold")
    .fillColor(blue)
    .fontSize(TITLE_FS)
    .text("Demande de\nramasse de pièces", pageLeft, titleY, {
      align: "center",
      width: pageRight - pageLeft,
      lineGap: 2,
    });

  doc.moveDown(3);
  let y = doc.y + GAP_AFTER_TITLE;

  doc.fontSize(SECTION_FS).fillColor(blue).text("Informations", pageLeft, y);
  y = doc.y + GAP_AFTER_INFO_HDR;

  const labelW    = 160;
  const valX      = pageLeft + labelW + 10;
  const valW      = pageRight - valX;
  const labelOpts = { width: labelW, lineBreak: false };
  const valOpts   = { width: valW, lineBreak: false };

  const {
dateStr, timeStr } = formatParisNow();
  doc
    .font("Helvetica-Bold")
    .fontSize(LABEL_FS)
    .fillColor(gray)
    .text("Date de demande :", pageLeft, y, labelOpts);
  doc
    .font("Helvetica")
    .fontSize(VALUE_FS)
    .fillColor("#000")
    .text(`${dateStr} ${timeStr}`, valX, y, valOpts);
  y += ROW_GAP;

  doc
    .font("Helvetica-Bold")
    .fontSize(LABEL_FS)
    .fillColor(gray)
    .text("Fournisseur :", pageLeft, y, labelOpts);
  doc
    .font("Helvetica")
    .fontSize(VALUE_FS)
    .fillColor("#000")
    .text(oneLine(fournisseur), valX, y, valOpts);
  y += ROW_GAP;

  if (infoLivreur && String(infoLivreur).trim()) {
    doc
      .font("Helvetica-Bold")
      .fontSize(LABEL_FS)
      .fillColor(gray)
      .text("Info livreur :", pageLeft, y, labelOpts);
    doc
      .font("Helvetica")
      .fontSize(VALUE_FS)
      .fillColor("#000")
      .text(oneLine(infoLivreur), valX, y, valOpts);
    y += ROW_GAP;
  }

  doc
    .font("Helvetica-Bold")
    .fontSize(LABEL_FS)
    .fillColor(gray)
    .text("Références :", pageLeft, y, labelOpts);
  doc
    .font("Helvetica")
    .fontSize(VALUE_FS)
    .fillColor("#000")
    .text(oneLine(pieces), valX, y, valOpts);
  y += ROW_GAP;

  doc
    .font("Helvetica-Bold")
    .fontSize(LABEL_FS)
    .fillColor(gray)
    .text("Destinataire(s) magasin :", pageLeft, y, labelOpts);
  doc
    .font("Helvetica")
    .fontSize(VALUE_FS)
    .fillColor("#000")
    .text(oneLine(magasinDest), valX, y, valOpts);
  y += ROW_GAP;

  if (demandeurNomPrenom && String(demandeurNomPrenom).trim()) {
    doc
      .font("Helvetica-Bold")
      .fontSize(LABEL_FS)
      .fillColor(gray)
      .text("Nom Prénom du demandeur :", pageLeft, y, labelOpts);
    doc
      .font("Helvetica")
      .fontSize(VALUE_FS)
      .fillColor("#000")
      .text(oneLine(demandeurNomPrenom), valX, y, valOpts);
    y += ROW_GAP;
  }

  if (commentaire && String(commentaire).trim()) {
    y += COMMENT_TOP_GAP;
    doc
      .font("Helvetica-Bold")
      .fontSize(LABEL_FS)
      .fillColor(gray)
      .text("Commentaire :", pageLeft, y);
    y = doc.y + COMMENT_LINE_GAP;
    doc
      .font("Helvetica")
      .fontSize(COMMENT_FS)
      .fillColor("#000")
      .text(String(commentaire), pageLeft, y, {
        width: pageRight - pageLeft,
      });
  }

  doc.end();
  return new Promise((resolve, reject) => {
    stream.on("finish", () => resolve(pdfPath));
    stream.on("error", reject);
  });
}

// Corps HTML du mail principal
function buildMailHtml({
  fournisseur,
  magasinDest,
  email,
  pieces,
  commentaire,
  ackUrl,
  demandeurNomPrenom,
}) {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.45;color:#111">
    <p>Bonjour,</p>
    <p>Merci d'effectuer une <strong>ramasse</strong> chez <strong>${esc(
      fournisseur
    )}</strong> pour la/les référence(s) suivante(s) :<br/><em>${esc(
      pieces || "—"
    )}</em>.</p>
    <p><strong>Destinataire(s) magasin :</strong> ${esc(
      magasinDest || "—"
    )}<br/>
       <strong>Demandeur :</strong> ${esc(email)}${
    demandeurNomPrenom ? ` – ${esc(demandeurNomPrenom)}` : ""
  }</p>
    ${
      commentaire
        ? `<p><strong>Commentaire :</strong><br/>${esc(
            String(commentaire)
          ).replace(/\n/g, "<br/>")}</p>`
        : ""
    }
    <p>
      <a href="${ackUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700">Accuser de réception</a>
    </p>
  </div>`;
}

// Signe un lien d'accuse
function signAck(params) {
  const h = crypto.createHmac("sha256", RAMASSE_SECRET);
  const keys = Object.keys(params).sort();
  const base = keys.map(k => `${k}=${params[k]}`).join("&");
  h.update(base);
  return h.digest("hex");
}

// Construit le lien d'accuse signe
function buildAckUrl(req, payload) {
  const urlBase = `${req.protocol}://${req.get("host")}`;
  const qs = new URLSearchParams(payload);
  const sig = signAck(Object.fromEntries(qs));
  qs.set("sig", sig);
  return `${urlBase}/api/ramasse/ack?${qs.toString()}`;
}

// Upload FTP
async function ftpUpload(localPath, remoteDir) {
  if (!process.env.FTP_HOST || !process.env.FTP_USER) return;
  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    await client.access({
      host: process.env.FTP_HOST,
      port: Number(process.env.FTP_PORT || 21),
      user: process.env.FTP_USER,
      password: process.env.FTP_PASSWORD,
      secure: String(process.env.FTP_SECURE || "false") === "true",
      secureOptions: {
        rejectUnauthorized:
          String(process.env.FTP_TLS_REJECT_UNAUTH || "1") !== "0",
      },
    });
    const root = (process.env.FTP_BACKUP_FOLDER || "/").replace(/\/$/, "");
    const targetDir = `${root}/${remoteDir}`.replace(/\/+/g, "/");
    await client.ensureDir(targetDir);
    const filename = path.basename(localPath);
    await client.uploadFrom(localPath, `${targetDir}/${filename}`);
  } catch (e) {
    console.error("[RAMASSE][FTP] upload error:", e.message);
  } finally {
    try {
      client.close();
    } catch {
    }
  }
}

const ackRecent   = new Map();
const ACK_TTL_MS  = 60 * 1000;

// Evite d'envoyer 2 fois le meme accuse
function shouldSendAckOnce(sig) {
  const now  = Date.now();
  const last = ackRecent.get(sig);

  for (const [k, t] of ackRecent) {
    if (now - t > ACK_TTL_MS) ackRecent.delete(k);
  }
  if (last && now - last < ACK_TTL_MS) return false;
  ackRecent.set(sig, now);
  return true;
}

// API: liste fournisseurs (pour le formulaire)
router.get("/fournisseurs", (_req, res) => {
  const out = loadFournisseurs().map(
    ({ name, magasin, infoLivreur }) => ({ name, magasin, infoLivreur })
  );
  res.json(out);
});

// API: liste magasins (pour le formulaire)
router.get("/magasins", (_req, res) => {
  res.json(loadMagasins());
});

// API: stats ramasse
router.get("/stats", (_req, res) => {
  try {
    const all = getCompteurs();
    const src = all.ramasseMagasins || {};
    const yearsSet = new Set();

    for (const m of Object.values(src)) {
      if (m && typeof m === "object" && m.byYear) {
        for (const y of Object.keys(m.byYear)) yearsSet.add(String(y));
      }
    }

    const years = Array.from(yearsSet).sort();
    res.json({ ok: true, data: { years, magasins: src } });
  } catch (e) {
    console.error("[RAMASSE][STATS] error:", e);
    res.status(500).json({ ok: false, error: "Erreur lecture stats ramasse" });
  }
});

// API: demande de ramasse (upload + mail + PDF)
router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (req.fileValidationError) {
      return res.status(400).json({ error: "file_type_not_allowed" });
    }
    const {
      fournisseur,
      magasin,
      email,
      pieces,
      commentaire,
      magasinDest,
      demandeurNomPrenom,
      requestId,
     } = req.body;

    // eviter double envoi
    const rid = String(requestId || req.get('x-request-id') || '').trim();
    if (rid && isDuplicateRamasse(rid)) {
      return res.json({ ok: true, dedup: true });
    }

    if (!fournisseur || !email || !pieces) {
      return res.status(400).json({
        error: "Champs requis manquants (fournisseur, email, pièces).",
      });
    }

    const four = findFournisseur(fournisseur);
    if (!four) {
      return res
        .status(400)
        .json({ error: "Fournisseur inconnu dans fournisseur.json" });
    }

    const mg         = four?.magasin || magasin || "";
    const recipients = uniqEmails(four?.recipients || []);
    const cc         = uniqEmails(four?.cc || []);

    if (!recipients.length) {
      return res.status(500).json({
        error:
          "Aucun destinataire configuré pour ce fournisseur (fournisseur.json).",
      });
    }

    const ackPayload = {
      email: String(email),
      fournisseur: String(four?.name || fournisseur),
      magasin: String(mg || ""),
      pieces: String(pieces || ""),
      ts: Date.now().toString(),
      nonce: crypto.randomBytes(8).toString("hex"),
    };
    const ackUrl = buildAckUrl(req, ackPayload);

    const pdfPath = await buildPdf({
      fournisseur: four?.name || fournisseur,
      magasinDest: magasinDest || mg,
      email,
      pieces,
      commentaire,
      demandeurNomPrenom,
      infoLivreur: four?.infoLivreur || "",
    });

    const subject     = `Demande de ramasse – ${four?.name || fournisseur}`;
    const htmlMagasin = buildMailHtml({
      fournisseur: four?.name || fournisseur,
      magasinDest: magasinDest || mg,
      email,
      pieces,
      commentaire,
      ackUrl,
      demandeurNomPrenom,
    });

    const attachmentsMagasin = [
      {
        filename: path.basename(pdfPath),
        path: pdfPath,
        contentType: "application/pdf",
      },
    ];

    if (req.file) {
      attachmentsMagasin.push({
        filename: req.file.originalname,
        path: req.file.path,
        contentType:
          req.file.mimetype ||
          mime.lookup(req.file.originalname) ||
          "application/octet-stream",
      });
    }

    // sans SMTP, pas d'envoi
    if (!transporter) {
      console.error("[RAMASSE] SMTP not configured");
      return res.status(500).json({ error: "smtp_not_configured" });
    }
await sendMailWithLog(
  transporter,
  {
    from: `"Demande de Ramasse" <${fromEmail}>`,
    to: recipients.join(", "),
    cc: cc.length ? cc.join(", ") : undefined,
    subject,
    html: htmlMagasin,
    attachments: attachmentsMagasin,
    replyTo: email,
  },
  "ramasse",
  {
    kind: "magasin",
    fournisseur: four?.name || fournisseur,
    magasinCharge: mg || "",
    magasinDest: magasinDest || mg || "",
    demandeur: email,
    pieces: (pieces || "").slice(0, 180),
  }
);

    const attachmentsUser = [];
    if (req.file) {
      attachmentsUser.push({
        filename: req.file.originalname,
        path: req.file.path,
        contentType:
          req.file.mimetype ||
          mime.lookup(req.file.originalname) ||
          "application/octet-stream",
      });
    }

await sendMailWithLog(
  transporter,
  {
    from: `"Demande de Ramasse" <${fromEmail}>`,
    to: String(email),
    subject: "Votre demande de ramasse a bien été envoye",
      html: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.6;color:#111">
          <div style="text-align:center;margin:24px 0 32px;">
            <span style="font-size:28px;">✔</span>
            <span style="font-size:24px;font-weight:700;color:#16a34a;margin-left:8px;">Ramasse demandée</span>
          </div>
          <p>Bonjour,</p>
          <p>Votre demande de ramasse a bien été envoyée.</p>
          <p>Un accusé de réception vous sera envoyé dès la prise en charge de la ramasse par le magasin.</p>
          <p>Nous la traiterons dans les plus brefs délais.</p>
          <p style="margin-top:16px;"><strong>Résumé de votre demande :</strong></p>
          <ul style="margin-top:8px;padding-left:18px;">
            <li><strong>Fournisseur :</strong> ${esc(four?.name || fournisseur)}</li>
            <li><strong>Magasin destinataire :</strong> ${esc(magasinDest || mg || "—")}</li>
            <li><strong>Références :</strong> ${esc(pieces || "—")}</li>
            ${
              demandeurNomPrenom
                ? `<li><strong>Demandeur :</strong> ${esc(demandeurNomPrenom)}</li>`
                : ""
            }
            ${
              commentaire
                ? `<li><strong>Commentaire :</strong> ${esc(
                    String(commentaire)
                  )}</li>`
                : ""
            }
          </ul>
          <p style="margin-top:16px;">
            Vous trouverez en pièce jointe une copie du document que vous avez ajouté à votre demande.
          </p>
        </div>
      `,
      attachments: attachmentsUser,
    },
  "ramasse",
  {
    kind: "demandeur",
    fournisseur: four?.name || fournisseur,
    magasinCharge: mg || "",
    magasinDest: magasinDest || mg || "",
    demandeur: email,
  }
);

    try {
  incrementRamasseMagasin(mg || "Inconnu");
} catch (e) {
  console.error("[RAMASSE] Erreur compteur ramasse :", e);
}

    const d    = new Date();
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, "0");
    await ftpUpload(pdfPath, `ramasse/${yyyy}/${mm}`);

    setTimeout(() => {
      try {
        fs.unlinkSync(pdfPath);
      } catch {}
      try {
        if (req.file) fs.unlinkSync(req.file.path);
      } catch {}
    }, 15_000);

    res.json({ ok: true });
  } catch (e) {
    console.error("[RAMASSE] POST error:", e);
    res.status(500).json({
      error: "Échec de l'envoi. Vérifiez la config SMTP / PDF / FTP.",
    });
  }
});
// Page d'accuse
router.get("/ack", (req, res) => {
  try {
    const { email, fournisseur, magasin, pieces, ts, nonce, sig } = req.query;
    if (!email || !fournisseur || !ts || !nonce || !sig) {
      return res.status(400).send("Lien incomplet");
    }

    const params = {
      email: String(email),
      fournisseur: String(fournisseur),
      magasin: String(magasin || ""),
      pieces: String(pieces || ""),
      ts: String(ts),
      nonce: String(nonce),
    };

    const expected = signAck(params);
    const ok =
      expected.length === String(sig).length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));

    if (!ok) return res.status(400).send("Signature invalide");

    const age = Date.now() - Number(ts);
    if (isFinite(age) && age > 14 * 24 * 3600 * 1000) {
      return res.status(400).send("Lien expiré");
    }

    res.status(200).send(`<!doctype html>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Accusé de réception</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:24px;color:#111}
  .box{max-width:520px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;padding:18px}
  .btn{display:inline-block;background:#2563eb;color:#fff;padding:12px 16px;border-radius:10px;
       text-decoration:none;font-weight:700;border:0;cursor:pointer;width:100%}
  .muted{color:#6b7280;font-size:14px;margin-top:10px}
</style>
<div class="box">
  <h2>Accuser de réception</h2>
  <p>Clique sur le bouton pour envoyer l’accusé au demandeur.</p>

  <form id="f" method="POST" action="/api/ramasse/ack">
    <input type="hidden" name="email" value="${esc(email)}"/>
    <input type="hidden" name="fournisseur" value="${esc(fournisseur)}"/>
    <input type="hidden" name="magasin" value="${esc(magasin || "")}"/>
    <input type="hidden" name="pieces" value="${esc(pieces || "")}"/>
    <input type="hidden" name="ts" value="${esc(ts)}"/>
    <input type="hidden" name="nonce" value="${esc(nonce)}"/>
    <input type="hidden" name="sig" value="${esc(sig)}"/>
    <button class="btn" type="submit">Accuser de réception</button>
  </form>

  <div class="muted">Aucun accusé n’est envoyé tant que tu ne cliques pas.</div>
</div>`);
  } catch (e) {
    console.error("[RAMASSE] ACK GET error:", e);
    res.status(400).send("Lien invalide.");
  }
});
// Envoi de l'accuse
router.post("/ack", async (req, res) => {
  try {
    const { email, fournisseur, magasin, pieces, ts, nonce, sig } = req.body;

    if (!email || !fournisseur || !ts || !nonce || !sig) {
      return res.status(400).send("Lien incomplet");
    }

    const params = {
      email: String(email),
      fournisseur: String(fournisseur),
      magasin: String(magasin || ""),
      pieces: String(pieces || ""),
      ts: String(ts),
      nonce: String(nonce),
    };

    const expected = signAck(params);
    const ok =
      expected.length === String(sig).length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));

    if (!ok) return res.status(400).send("Signature invalide");

    const age = Date.now() - Number(ts);
    if (isFinite(age) && age > 14 * 24 * 3600 * 1000) {
      return res.status(400).send("Lien expiré");
    }

    const sendNow = shouldSendAckOnce(String(sig));
    if (!sendNow) {
      return res
        .status(200)
        .send(`<!doctype html><meta charset="utf-8"/>
<div style="font-family:system-ui;padding:24px">✅ Accusé déjà envoyé.</div>`);
    }

    if (!transporter) {
      return res.status(500).send("SMTP non configuré");
    }

await sendMailWithLog(
  transporter,
  {
    from: `"Accusé Demande de Ramasse" <${fromEmail}>`,
      to: String(email),
      subject: `Accusé de réception – Demande de ramasse (${String(fournisseur)})`,
      html: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.6;color:#111">
          <div style="text-align:center;margin:24px 0 32px;">
            <span style="font-size:28px;">✔</span>
            <span style="font-size:24px;font-weight:700;color:#16a34a;margin-left:8px;">Accusé de réception</span>
          </div>
          <p>Bonjour,</p>
          <p>Votre demande de ramasse pour <strong>${esc(fournisseur)}</strong>
          concernant <em>${esc(pieces || "—")}</em> a bien été prise en compte par le magasin
          <strong>${esc(magasin || "—")}</strong>.</p>
          <p>Cordialement,<br/>L'équipe Ramasse</p>
        </div>
      `,
     },
  "ramasse",
  {
    kind: "ack",
    fournisseur: String(fournisseur),
    magasin: String(magasin || ""),
    demandeur: String(email),
    pieces: String(pieces || "").slice(0, 180),
  }
);

    res.status(200).send(`<!doctype html><meta charset="utf-8"/>
<div style="font-family:system-ui;padding:24px">✅ Accusé de réception envoyé.</div>`);
  } catch (e) {
    console.error("[RAMASSE] ACK POST error:", e);
    res.status(400).send("Lien invalide ou erreur d'envoi.");
  }
});

export default router;
