import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { transporter, fromEmail } from "../mailer.js";
import mime from "mime-types";
import ftp from "basic-ftp";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import axios from "axios";
import ExcelJS from "exceljs";
import rateLimit from "express-rate-limit";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

console.log("[GARANTIE][CONF][MAIL] fromEmail =", fromEmail || "(vide)");
console.log("[GARANTIE][CONF][MAIL] transporter =", transporter ? "OK" : "ABSENT");

// Constantes
const STATUTS = {
  ENREGISTRE: "enregistré",
  ACCEPTE: "accepté",
  REFUSE: "refusé",
  ATTENTE_INFO: "Avoir Commercial",
  ATTENTE_MO: "Attente MO",
};

const MAGASINS = [
  "Annemasse", "Bourgoin-Jallieu", "Chasse-sur-Rhone", "Chassieu", "Gleize", "La Motte-Servolex",
  "Les Echets", "Pavi", "Rives", "Saint-Egreve", "Saint-Jean-Bonnefonds", "Saint-martin-d'heres", "Seynod"
];


// ---- Helpers ENV (compat Render/Unix) ----
// Render (et beaucoup d'UI) n'acceptent pas les noms de variables avec des tirets.
// Donc on accepte plusieurs noms pour une mÃªme config (ex: "admin-pass" ET "ADMIN_PASS").
function envGetAny(names = []) {
  for (const n of names) {
    if (!n) continue;
    const v = process.env[n];
    if (v != null && String(v).trim() !== "") return String(v);
  }
  return "";
}

function normEnvChunk(str) {
  return String(str || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")      // accents
    .replace(/[^a-zA-Z0-9]+/g, "_")         // tout sauf alnum -> _
    .replace(/^_+|_+$/g, "")                // trim _
    .replace(/_+/g, "_")                    // collapse
    .toUpperCase();
}

function magasinKeyLegacy(magasin) {
  // ex: "Saint-martin-d'heres" -> "magasin-Saint-martin-d-heres-pass"
  return "magasin-" + String(magasin || "").replace(/[^\w]/g, "-") + "-pass";
}
function magasinKeyEnv(magasin) {
  // ex: "Saint-martin-d'heres" -> "MAGASIN_SAINT_MARTIN_D_HERES_PASS"
  return "MAGASIN_" + normEnvChunk(magasin) + "_PASS";
}

function limitedKeyLegacy(name) { return "magasin-" + name + "-limited"; }
function limitedKeyEnv(name) { return "MAGASIN_" + normEnvChunk(name) + "_LIMITED"; }

function trimPw(pw) {
  // sÃ©curise les copier/coller (espaces, retours chariot)
  return String(pw || "").replace(/\r?\n/g, "").trim();
}

const garantieLoginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.GARANTIE_LOGIN_RATE_LIMIT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Trop de tentatives, reessayez plus tard." },
});

function getGarantieAuth(req) {
  return req.session?.garantieAuth || null;
}

function canAccessMagasin(auth, magasin) {
  if (!auth) return false;
  if (auth.isSuper || auth.isAdmin) return true;

  const target = String(magasin || "").trim().toLowerCase();
  if (!target) return false;

  if (Array.isArray(auth.multiMagasins) && auth.multiMagasins.length) {
    return auth.multiMagasins.some((m) => String(m || "").trim().toLowerCase() === target);
  }
  if (auth.magasin) {
    return String(auth.magasin).trim().toLowerCase() === target;
  }
  return false;
}

function canAccessDossier(auth, dossier) {
  return canAccessMagasin(auth, dossier?.magasin);
}

function requireGarantieRead(req, res, next) {
  const auth = getGarantieAuth(req);
  if (!auth) return res.status(401).json({ success: false, message: "Authentification requise." });
  req.garantieAuth = auth;
  return next();
}

function requireGarantieWrite(req, res, next) {
  const auth = getGarantieAuth(req);
  if (!auth) return res.status(401).json({ success: false, message: "Authentification requise." });
  if (auth.isLimited) {
    return res.status(403).json({ success: false, message: "Acces en lecture seule." });
  }
  req.garantieAuth = auth;
  return next();
}

function requireGarantieSuper(req, res, next) {
  const auth = getGarantieAuth(req);
  if (!auth) return res.status(401).json({ success: false, message: "Authentification requise." });
  if (!auth.isSuper) {
    return res.status(403).json({
      success: false,
      message: "Suppression autorisee uniquement pour le super admin."
    });
  }
  req.garantieAuth = auth;
  return next();
}

// Fonction pour parser JSON depuis env
function parseEnvJsonObject(varName) {
  const raw0 = (process.env[varName] || "").trim();
  if (!raw0) return {};
  let raw = raw0;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === "'" || first === '"' || first === "`") && last === first) {
    raw = raw.slice(1, -1).trim();
  }
  try {
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  } catch (e) {
    console.warn(`[GARANTIE][CONF] Impossible de parser ${varName}:`, e?.message || e);
    return {};
  }
}

const MAGASIN_MAILS = parseEnvJsonObject("MAGASIN_MAILS_JSON");
const FOURNISSEUR_MAILS = parseEnvJsonObject("FOURNISSEUR_MAILS_JSON");
console.log("[GARANTIE][CONF] MAGASIN_MAILS keys =", Object.keys(MAGASIN_MAILS));

const FOURNISSEUR_PDFS = {
  "FEBI": "FICHE_GARANTIE_FEBI.pdf",
  "METELLI": "formulaire_garantie_metelli.pdf",
  "EFI": "Formulaire_EFI.pdf",
  "MAGNETI": "FORMULAIRE_MAGNETI.pdf",
  "QH": "FORMULAIRE_QH.pdf",
  "RIAL": "DEMANDE_RIAL.pdf",
  "AUTOGAMMA": "Formulaire_ AUTOGAMMA.pdf",
  "DELPHI": "Formulaire_delphi.pdf",
  "MS MOTORS": "FORMULAIRE_ms.pdf",
  "NGK": "Formulaire_ngk.pdf",
  "NRF": "Formulaire_nrf.pdf",
  "SEIM": "Formulaire_SEIM.pdf"
};

// Configuration FTP
const FTP_HOST = process.env.FTP_HOST;
const FTP_PORT = Number(process.env.FTP_PORT || 21);
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS || process.env.FTP_PASSWORD;
const FTP_BACKUP_FOLDER =
  process.env.GARANTIE_FTP_BACKUP_FOLDER ||
  process.env.FTP_BACKUP_FOLDER ||
  "/Disque 1/sauvegardegarantie";
const FTP_SECURE = String(process.env.FTP_SECURE || "true").toLowerCase();
// FTP_TLS_INSECURE=1 désactive la validation du certificat (dev uniquement, NE PAS utiliser en prod)
const FTP_TLS_INSECURE = String(process.env.FTP_TLS_INSECURE || "").trim() === "1";
// Par défaut rejectUnauthorized=true ; mettre FTP_TLS_REJECT_UNAUTH=0 pour le désactiver (déconseillé)
const FTP_TLS_REJECT_UNAUTH = String(process.env.FTP_TLS_REJECT_UNAUTH || "").trim() !== "0";
const JSON_FILE_FTP = path.posix.join(FTP_BACKUP_FOLDER, "demandes.json");
const UPLOADS_FTP = path.posix.join(FTP_BACKUP_FOLDER, "uploads");

// Configuration Multer pour upload de fichiers
const TEMP_UPLOAD_DIR = path.join(__dirname, "..", "temp_uploads_garantie");
try { fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true }); } catch {}
const GARANTIE_ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/bmp",
  "image/tiff",
  "text/plain",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/zip",
  "application/x-zip-compressed",
]);
const GARANTIE_ALLOWED_EXT = new Set([
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".bmp",
  ".tif",
  ".tiff",
  ".txt",
  ".csv",
  ".xls",
  ".xlsx",
  ".doc",
  ".docx",
  ".zip",
]);

function isAllowedGarantieFile(file) {
  const mimeType = String(file?.mimetype || "").toLowerCase();
  const ext = String(path.extname(file?.originalname || "") || "").toLowerCase();
  const mimeAllowed = GARANTIE_ALLOWED_MIME.has(mimeType) || mimeType === "application/octet-stream";
  return mimeAllowed && GARANTIE_ALLOWED_EXT.has(ext);
}

const upload = multer({
  dest: TEMP_UPLOAD_DIR,
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 20,
  },
  fileFilter: (req, file, cb) => {
    if (isAllowedGarantieFile(file)) return cb(null, true);
    req.fileValidationError = "file_type_not_allowed";
    return cb(null, false);
  },
});

async function getFTPClient() {
  const client = new ftp.Client(10000);
  client.ftp.verbose = false;
  try {
    await client.access({
      host: FTP_HOST,
      port: FTP_PORT,
      user: FTP_USER,
      password: FTP_PASS,
      secure: FTP_SECURE === "true" || FTP_SECURE === "1",
      secureOptions: { rejectUnauthorized: FTP_TLS_REJECT_UNAUTH && !FTP_TLS_INSECURE }
    });
    return client;
  } catch (err) {
    client.close();
    console.error("[FTP] Erreur de connexion :", err && err.message ? err.message : err);
    throw new Error("Erreur de connexion au serveur FTP");
  }
}

// Lit demandes.json sur le FTP et renvoie un tableau.
async function readDataFTP() {
  let client;
  try {
    client = await getFTPClient();
  } catch (err) {
    console.error("[FTP] Impossible de se connecter pour lire demandes.json :", err.message || err);
    return [];
  }
  let json = [];
  try {
    const tmp = path.join(__dirname, "temp_demandes.json");
    await client.downloadTo(tmp, JSON_FILE_FTP);
    try {
      json = JSON.parse(fs.readFileSync(tmp, "utf8"));
    } catch (parseErr) {
      console.error("[FTP] Erreur de parsing de demandes.json :", parseErr.message || parseErr);
      json = [];
    }
    try { fs.unlinkSync(tmp); } catch {}
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes("Server sent FIN packet unexpectedly")) {
      console.warn("[FTP] FIN inattendu en lecture de demandes.json, retour d'une liste vide.");
    } else {
      console.error("[FTP] Erreur lors de la lecture de demandes.json :", msg);
    }
    json = [];
  } finally {
    if (client) client.close();
  }
  if (Array.isArray(json)) {
    json.forEach(d => {
      if (d && typeof d.statut === "string") {
        if (d.statut.toLowerCase() === "en attente d'info") {
          d.statut = STATUTS.ATTENTE_INFO;
        }
      }
    });
  }
  return json;
}

// Ecrit demandes.json sur le FTP avec les nouvelles donnees.
async function writeDataFTP(data) {
  let client;
  const rand = Math.round(Math.random() * 1e9);

  // tmp local unique (évite collision si 2 saves en même temps)
  const tmpLocal = path.join(__dirname, `temp_demandes_${Date.now()}_${rand}.json`);

  // tmp distant unique puis rename vers demandes.json
  const remoteDir = FTP_BACKUP_FOLDER;
  const remoteFinal = JSON_FILE_FTP;
  const remoteTmp = path.posix.join(
    remoteDir,
    `demandes.json.tmp-${Date.now()}-${rand}`
  );

  try {
    client = await getFTPClient();

    // 1) Ecrit local
    fs.writeFileSync(tmpLocal, JSON.stringify(data, null, 2), "utf8");

    // hash local (preuve + debug)
    const localBuf = fs.readFileSync(tmpLocal);
    const localSha = crypto.createHash("sha256").update(localBuf).digest("hex");

    // 2) Upload vers fichier tmp distant
    await client.ensureDir(remoteDir);
    await client.uploadFrom(tmpLocal, remoteTmp);

    // 3) Remplacement “quasi-atomique”
    // Certains FTP refusent rename over existing -> on supprime puis rename
    try { await client.remove(remoteFinal).catch(() => {}); } catch {}
    try {
      await client.rename(remoteTmp, remoteFinal);
    } catch (e) {
      // fallback : upload direct vers final si rename indisponible
      console.warn("[GARANTIE][FTP] rename tmp->final échoué, fallback upload direct:", e?.message || e);
      await client.uploadFrom(tmpLocal, remoteFinal);
      await client.remove(remoteTmp).catch(() => {});
    }

    // 4) Vérif : size + hash distant (download)
    let size = 0;
    try { size = await client.size(remoteFinal); } catch {}
    if (!size || size < 10) {
      throw new Error(`Ecriture FTP incertaine (size=${size})`);
    }

    const verifyLocal = path.join(__dirname, `verify_demandes_${Date.now()}_${rand}.json`);
    try {
      await client.downloadTo(verifyLocal, remoteFinal);
      const remoteBuf = fs.readFileSync(verifyLocal);
      const remoteSha = crypto.createHash("sha256").update(remoteBuf).digest("hex");
if (localSha !== remoteSha) {
  console.warn(
    `[GARANTIE][SAVE] SHA différent mais sauvegarde probablement OK`,
    { localSha, remoteSha }
  );
}

    } finally {
      try { fs.unlinkSync(verifyLocal); } catch {}
    }

    console.log(`[GARANTIE][SAVE] demandes.json OK (${Array.isArray(data) ? data.length : "?"} dossiers) size=${size}`);
  } catch (err) {
    console.error("[GARANTIE][SAVE] ECHEC demandes.json :", err?.message || err);
    // IMPORTANT : on throw pour éviter les faux "success:true"
    throw new Error(err?.message || "Erreur lors de la sauvegarde des données sur le FTP.");
  } finally {
    try { fs.unlinkSync(tmpLocal); } catch {}
    try { client && client.close(); } catch {}
  }
}

// Envoie un fichier local vers le FTP (dossier uploads).
async function uploadFileToFTP(localPath, remoteSubfolder = "uploads", remoteFileName = null) {
  let client;
  try {
    client = await getFTPClient();
  } catch (err) {
    console.error("[FTP] Impossible de se connecter pour uploader un fichier :", err.message || err);
    throw new Error("Erreur de connexion au FTP pour l'upload de fichier.");
  }
  const remoteName = remoteFileName || path.basename(localPath);
  const remoteDir = path.posix.join(FTP_BACKUP_FOLDER, remoteSubfolder);
  const remotePath = path.posix.join(remoteDir, remoteName);
  try {
    await client.ensureDir(remoteDir);
    await client.uploadFrom(localPath, remotePath);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes("Server sent FIN packet unexpectedly")) {
      console.error("[FTP] FIN inattendu pendant l'upload :", remotePath, msg);
    } else {
      console.error("[FTP] Erreur upload FTP :", remotePath, msg);
    }
    throw new Error("Erreur lors de l'envoi du fichier sur le FTP.");
  } finally {
    if (client) client.close();
  }
}

// Supprime plusieurs fichiers sur le FTP (si possible).
async function deleteFilesFromFTP(urls = []) {
  if (!urls.length) return;
  let client;
  try {
    client = await getFTPClient();
  } catch (err) {
    console.error("[FTP] Impossible de se connecter pour supprimer plusieurs fichiers :", err.message || err);
    return;
  }
  try {
    for (const remoteFileName of urls) {
      if (!remoteFileName) continue;
      const remotePath = path.posix.join(UPLOADS_FTP, remoteFileName);
      try {
        await client.remove(remotePath);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (msg.includes("Server sent FIN packet unexpectedly")) {
          console.warn("[FTP] FIN inattendu lors de la suppression (ignorÃ©e) :", remotePath, msg);
        } else {
          console.warn("[FTP] Erreur lors de la suppression du fichier (ignorÃ©e) :", remotePath, msg);
        }
      }
    }
  } finally {
    if (client) client.close();
  }
}

// Stream un fichier FTP directement dans la reponse HTTP.
async function streamFTPFileToRes(res, remotePath, fileName) {
  let client;
  try {
    client = await getFTPClient();
  } catch (err) {
    console.error("[FTP] Impossible de se connecter pour streamer un fichier :", err.message || err);
    if (!res.headersSent) {
      res.status(500).send("Erreur de connexion au serveur de fichiers.");
    } else {
      res.end();
    }
    return;
  }
  try {
    let size = 0;
    try {
      size = await client.size(remotePath);
    } catch {}
    const ctype = mime.lookup(fileName) || "application/octet-stream";
    if (!res.headersSent) {
      res.setHeader("Content-Type", ctype);
      if (size > 0) res.setHeader("Content-Length", String(size));
      const ext = (fileName || "").split(".").pop().toLowerCase();
      const inlineTypes = ["pdf","jpg","jpeg","png","gif","webp","bmp"];
      const disp = inlineTypes.includes(ext) ? "inline" : "attachment";
      res.setHeader("Content-Disposition", `${disp}; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    }
    await client.downloadTo(res, remotePath);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes("Server sent FIN packet unexpectedly")) {
      console.error("[FTP] FIN inattendu pendant le streaming du fichier :", remotePath, msg);
    } else {
      console.error("[FTP] Erreur pendant le tÃ©lÃ©chargement du fichier :", remotePath, msg);
    }
    if (!res.headersSent) {
      res.status(500).send("Erreur lors du tÃ©lÃ©chargement du fichier.");
    } else {
      res.end();
    }
  } finally {
    if (client) client.close();
  }
}

// Telecharge des fichiers du FTP vers des fichiers temporaires.
async function fetchFilesFromFTP(fileObjs) {
  if (!fileObjs || !fileObjs.length) return [];
  let client;
  try {
    client = await getFTPClient();
  } catch (err) {
    console.error("[FTP] Impossible de se connecter pour rÃ©cupÃ©rer les piÃ¨ces jointes :", err.message || err);
    return [];
  }
  const files = [];
  try {
    for (const f of fileObjs) {
      if (!f || !f.url) continue;
      const remote = path.posix.join(UPLOADS_FTP, f.url);
      const safeLocal = "att_" + f.url.replace(/[^\w.\-]/g,"_");
      const tempPath = path.join(__dirname, safeLocal);
      try {
        await client.downloadTo(tempPath, remote);
        files.push({ filename: f.original, path: tempPath });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (msg.includes("Server sent FIN packet unexpectedly")) {
          console.warn("[FTP] FIN inattendu pendant le tÃ©lÃ©chargement d'une PJ (ignorÃ©e) :", remote, msg);
        } else {
          console.warn("[FTP] Erreur lors du tÃ©lÃ©chargement d'une PJ (ignorÃ©e) :", remote, msg);
        }
      }
    }
  } finally {
    if (client) client.close();
  }
  return files;
}

// Nettoie les fichiers temporaires locaux.
function cleanupFiles(arr) {
  if (!arr || !arr.length) return;
  for (const f of arr) {
    if (f && f.path && fs.existsSync(f.path)) {
      try { fs.unlinkSync(f.path); } catch {}
    }
  }
}

// Recupere le logo en ligne pour le PDF.
async function getLogoBuffer() {
  const url = "https://raw.githubusercontent.com/docudurand/docudurpho/main/DSG.png";
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data, "binary");
}

// Formate une date en JJ/MM/AAAA (ou renvoie brut si invalide).
function formatDateJJMMAAAA(input) {
  if (!input) return "";
  const s = String(input).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    const dt = new Date(s);
    if (isNaN(dt)) return s;
    y = dt.getFullYear(); mo = dt.getMonth() + 1; d = dt.getDate();
  }
  return `${String(d).padStart(2,"0")}/${String(mo).padStart(2,"0")}/${String(y)}`;
}

// Genere le PDF recapitulatif d'une demande.
async function creerPDFDemande(d, nomFichier) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 32, size: "A4" });
      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      const logo = await getLogoBuffer();
      const PAGE_W = doc.page.width;
      const logoW = 55, logoH = 55;
      const x0 = 36; let y0 = 36;
      doc.image(logo, x0, y0, { width: logoW, height: logoH });
      doc.font("Helvetica-Bold").fontSize(20).fillColor("#14548C");
      doc.text("DURAND SERVICES GARANTIE", x0 + logoW + 12, y0 + 6);
      doc.font("Helvetica").fontSize(14).fillColor("#14548C");
      doc.text(d.magasin || "", x0 + logoW + 12, y0 + 32);
      doc.fontSize(11).fillColor("#000");
      const dateStrFr = d.date ? new Date(d.date).toLocaleDateString("fr-FR") : "";
      const numero = d.numero_dossier || "";
      doc.text("CrÃ©Ã© le : " + dateStrFr, PAGE_W - 150, y0 + 6, { width: 120 });
      doc.text("NumÃ©ro de dossier : " + numero, PAGE_W - 150, y0 + 20, { width: 120 });
      let y = y0 + logoH + 32;
      const tableW = PAGE_W - 2 * x0;
      const colLabelW = 155;
      const colValW = tableW - colLabelW;
      const rowHeight = 22;
      const labelFont = "Helvetica-Bold";
      const valueFont = "Helvetica";
      const rows = [
        ["Nom du client", d.nom || ""],
        ["Email", d.email || ""],
        ["Magasin", d.magasin || "", "rowline"],
        ["Marque du produit", d.marque_produit || ""],
        ["Produit concernÃ©", d.produit_concerne || ""],
        ["RÃ©fÃ©rence de la piÃ¨ce", d.reference_piece || ""],
        ["QuantitÃ© posÃ©e", d.quantite_posee || "", "rowline"],
        ["Immatriculation", d.immatriculation || ""],
        ["Marque", d.marque_vehicule || ""],
        ["ModÃ¨le", d.modele_vehicule || ""],
        ["NumÃ©ro de sÃ©rie", d.num_serie || ""],
        ["1Ã¨re immatriculation", formatDateJJMMAAAA(d.premiere_immat) || "", "rowline"],
        ["Date de pose", formatDateJJMMAAAA(d.date_pose) || ""],
        ["Date du constat", formatDateJJMMAAAA(d.date_constat) || ""],
        ["KilomÃ©trage Ã  la pose", d.km_pose || ""],
        ["KilomÃ©trage au constat", d.km_constat || ""],
        ["NÂ° BL 1Ã¨re Vente", d.bl_pose || ""],
        ["NÂ° BL 2Ã¨me Vente", d.bl_constat || "", "rowline"],
        ["ProblÃ¨me rencontrÃ©", (d.probleme_rencontre||"").replace(/\r\n/g,"\n").replace(/\r/g,"\n"), "multiline"]
      ];
      const sidePad = 16;
      const cornerRad = 14;

      function cellHeightFor(row) {
        const [ , value, type] = row;
        if (type === "multiline") {
          const h = doc.font(valueFont).fontSize(11).heightOfString(value || "", {
            width: colValW - (sidePad * 2), align: "left"
          });
          const lines = Math.max(1, Math.ceil(h / rowHeight));
          return lines * rowHeight;
        }
        return rowHeight;
      }
      const heights = rows.map(cellHeightFor);
      const tableH = heights.reduce((a,b)=>a+b,0);
      doc.roundedRect(x0, y, tableW, tableH, cornerRad).fillAndStroke("#fff", "#3f628c");
      doc.lineWidth(1.7).roundedRect(x0, y, tableW, tableH, cornerRad).stroke("#3f628c");
      let yCursor = y;
      for (let i = 0; i < rows.length; i++) {
        const [label, value, type] = rows[i];
        const cellHeight = heights[i];
        doc.font(labelFont).fontSize(11).fillColor("#000")
          .text(label, x0 + sidePad, yCursor + 4, { width: colLabelW - sidePad, align: "left" });
        doc.font(valueFont).fontSize(11).fillColor("#000")
          .text(value || "", x0 + colLabelW + sidePad, yCursor + 4, { width: colValW - (sidePad * 2), align: "left" });
        let drawLine = false;
        if (type === "rowline") drawLine = true;
        else if (i < rows.length - 1 && rows[i+1][2] !== "multiline" && type !== "multiline") drawLine = true;
        if (i === rows.length - 1) drawLine = false;
        if (drawLine) {
          doc.moveTo(x0 + 8, yCursor + cellHeight).lineTo(x0 + tableW - 8, yCursor + cellHeight)
            .strokeColor("#b3c5df").lineWidth(1).stroke();
        }
        yCursor += cellHeight;
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

// API: cree une demande, upload, PDF, mails, sauvegarde.
router.post("/demandes", upload.array("document"), async (req, res) => {
  try {
    if (req.fileValidationError) {
      return res.status(400).json({ success: false, message: "Type de fichier non autorise." });
    }
    let data = await readDataFTP();
    if (!Array.isArray(data)) data = [];
    const d = req.body;
    d.id = Date.now().toString(36) + Math.random().toString(36).slice(2,7);
    d.date = new Date().toISOString();
    let maxNum = 0;
    for (const dossier of data) {
      const n = parseInt(dossier.numero_dossier, 10);
      if (!Number.isNaN(n) && n > maxNum) maxNum = n;
    }
    d.numero_dossier = String(maxNum + 1).padStart(4, "0");
    d.statut = STATUTS.ENREGISTRE;
    d.attente_mo = false;
    d.files = [];
    for (const f of req.files || []) {
      const cleanedOriginal = f.originalname.replace(/\s/g, "_");
      const remoteName = `${Date.now()}-${Math.round(Math.random()*1e8)}-${cleanedOriginal}`;
      await uploadFileToFTP(f.path, "uploads", remoteName);
      d.files.push({ url: remoteName, original: f.originalname });
      try { fs.unlinkSync(f.path); } catch {}
    }
    d.reponse = "";
    d.reponseFiles = [];
    d.documentsAjoutes = [];
    data.push(d);
    await writeDataFTP(data);
    const clientNom = (d.nom||"Client").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    let dateStr = "";
    if (d.date) {
      const dt = new Date(d.date);
      if (!isNaN(dt)) dateStr = dt.toISOString().slice(0,10);
    }
    const nomFichier = `${clientNom}${dateStr ? "_" + dateStr : ""}.pdf`;
const pdfBuffer = await creerPDFDemande(d, nomFichier.replace(/\.pdf$/, ""));

const tmpPdfPath = path.join(__dirname, `tmp_${Date.now()}_${Math.round(Math.random()*1e6)}_${nomFichier}`);
fs.writeFileSync(tmpPdfPath, pdfBuffer);

let mailClientOk = false;
let mailMagasinOk = false;

try {

  if (d.email) {
    const toClient = String(d.email || "").trim();
    if (!transporter) {
      console.error("[MAIL] SMTP not configured. Unable to send client confirmation.");
    } else {
      try {
        const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.45;">
          Bonjour,<br><br>
          Votre demande de garantie a Ã©tÃ© envoyÃ©e avec succÃ¨s.<br>
          Merci dâ€™imprimer et de joindre le fichier PDF ci-joint avec votre piÃ¨ce.<br><br>
          <b>Magasin :</b> ${d.magasin || ""}<br>
          <b>Produit :</b> ${d.produit_concerne || ""}<br>
          <b>RÃ©fÃ©rence :</b> ${d.reference_piece || ""}<br><br>
          Cordialement<br>
          L'Ã©quipe Durand Services Garantie.
        </div>`;

        await transporter.sendMail({
          from: `Durand Services Garantie <${fromEmail}>`,
          to: toClient,
          subject: "Demande de Garantie EnvoyÃ©e",
          html,
          attachments: [{ filename: nomFichier, path: tmpPdfPath, contentType: "application/pdf" }]
        });

        mailClientOk = true;
        console.log("[MAIL] OK client:", toClient);
      } catch (e) {
        console.error("[MAIL] ERREUR client:", e?.message || e);
      }
    }
  }

  const respMail = String(MAGASIN_MAILS[d.magasin] || "").trim();
  if (respMail) {
    const attachments = await fetchFilesFromFTP(d.files);

    if (!transporter) {
      console.error("[MAIL] SMTP not configured. Unable to send magasin notification.");
    } else {
      try {
        const finalAtt = [
          { filename: nomFichier, path: tmpPdfPath, contentType: "application/pdf" },
          ...attachments.map(f => ({ filename: f.filename, path: f.path }))
        ];

        await transporter.sendMail({
          from: `Durand Services Garantie <${fromEmail}>`,
          to: respMail,
          subject: `Nouvelle demande de garantie`,
          html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.45;">
                  <b>Nouvelle demande reÃ§ue pour le magasin ${d.magasin}.</b><br>
                  Client : ${d.nom || ""} (${d.email || ""})<br>
                  Marque du produit : ${d.marque_produit || ""}<br>
                  Produit : ${d.produit_concerne || ""}<br>
                  RÃ©fÃ©rence : ${d.reference_piece || ""}<br>
                  Date : ${(new Date()).toLocaleDateString("fr-FR")}<br><br>
                  Le PDF de demande est joint Ã  ce mail.
                </div>`,
          attachments: finalAtt
        });

        mailMagasinOk = true;
        console.log("[MAIL] OK magasin:", d.magasin, respMail);
      } catch (e) {
        console.error("[MAIL] ERREUR magasin:", e?.message || e);
      }
    }

    cleanupFiles(attachments);
  }
} finally {

  try { fs.unlinkSync(tmpPdfPath); } catch {}
}

res.json({ success: true, mailClientOk, mailMagasinOk });
  } catch (err) {
    console.error("Erreur /api/demandes :", err.message || err);
    res.json({ success: false, message: err.message });
  }
});

// API admin: met a jour un dossier (statut, reponse, PJ).
router.post("/admin/dossier/:id",
  requireGarantieWrite,
  upload.fields([{ name: "reponseFiles", maxCount: 10 }, { name: "documentsAjoutes", maxCount: 10 }]),
  async (req, res) => {
    try {
      if (req.fileValidationError) {
        return res.status(400).json({ success: false, message: "Type de fichier non autorise." });
      }
      const { id } = req.params;
      let data = await readDataFTP();
      if (!Array.isArray(data)) data = [];
      const dossier = data.find(x => x.id === id);
      if (!dossier) return res.json({ success:false, message:"Dossier introuvable" });
      if (!canAccessDossier(req.garantieAuth, dossier)) {
        return res.status(403).json({ success: false, message: "Acces refuse pour ce magasin." });
      }
      const oldStatut = dossier.statut;
      const oldReponse = dossier.reponse;
      const oldFilesLength = (dossier.reponseFiles||[]).length;
      const rawStatut =
  (typeof req.body.statut === "string" && req.body.statut) ||
  (typeof req.body.status === "string" && req.body.status) ||
  (typeof req.body.statutClient === "string" && req.body.statutClient) ||
  "";

const statutRecu = rawStatut ? String(rawStatut).trim() : undefined;
      const repRecue = req.body.reponse;
      const nbAvoir = req.body.numero_avoir;
      let attenteFlagProvided = Object.prototype.hasOwnProperty.call(req.body, "attente_mo");
      let attenteFlag = false;
      if (attenteFlagProvided) {
        const v = String(req.body.attente_mo).toLowerCase();
        attenteFlag = (v === "on" || v === "true" || v === "1");
      }
      if (repRecue !== undefined) dossier.reponse = repRecue;
      if (nbAvoir !== undefined) dossier.numero_avoir = nbAvoir;
      dossier.reponseFiles = dossier.reponseFiles || [];
      dossier.documentsAjoutes = dossier.documentsAjoutes || [];
      if (req.files && req.files.reponseFiles) {
        for (const f of req.files.reponseFiles) {
          const cleanedOriginal = f.originalname.replace(/\s/g, "_");
          const remoteName = `${Date.now()}-${Math.round(Math.random() * 1e8)}-${cleanedOriginal}`;
          await uploadFileToFTP(f.path, "uploads", remoteName);
          dossier.reponseFiles.push({ url: remoteName, original: f.originalname });
          try { fs.unlinkSync(f.path); } catch {}
        }
      }
      if (req.files && req.files.documentsAjoutes) {
        for (const f of req.files.documentsAjoutes) {
          const cleanedOriginal = f.originalname.replace(/\s/g, "_");
          const remoteName = `${Date.now()}-${Math.round(Math.random() * 1e8)}-${cleanedOriginal}`;
          await uploadFileToFTP(f.path, "uploads", remoteName);
          dossier.documentsAjoutes.push({ url: remoteName, original: f.originalname });
          try { fs.unlinkSync(f.path); } catch {}
        }
      }
      if (typeof dossier.attente_mo !== "boolean") dossier.attente_mo = false;
      let suppressNotif = false;
      if (attenteFlagProvided) {
        dossier.attente_mo = attenteFlag;
        if (attenteFlag) {
          dossier.statut = STATUTS.ATTENTE_MO;
          suppressNotif = true;
        } else {
        }
      }
      if (statutRecu) {
        const s = statutRecu.toLowerCase();
        if (s === STATUTS.ACCEPTE.toLowerCase()) {
          dossier.statut = STATUTS.ACCEPTE;
          dossier.attente_mo = false;
        } else if (s === STATUTS.REFUSE.toLowerCase()) {
          dossier.statut = STATUTS.REFUSE;
        } else if (s === STATUTS.ENREGISTRE.toLowerCase()) {
          dossier.statut = STATUTS.ENREGISTRE;
        } else if (s === STATUTS.ATTENTE_INFO.toLowerCase()) {
          dossier.statut = STATUTS.ATTENTE_INFO;
        } else if (s === STATUTS.ATTENTE_MO.toLowerCase()) {
          dossier.statut = STATUTS.ATTENTE_MO;
          dossier.attente_mo = true;
          suppressNotif = true;
        }
      }
      await writeDataFTP(data);
      let mailDoitEtreEnvoye = false;
      const changes = [];
      if (dossier.statut !== oldStatut && !suppressNotif) {
        changes.push("statut");
        mailDoitEtreEnvoye = true;
      }
      if (repRecue !== undefined && repRecue !== oldReponse) {
        changes.push("rÃ©ponse");
        mailDoitEtreEnvoye = true;
      }
      if (req.files && req.files.reponseFiles && req.files.reponseFiles.length > 0 && (dossier.reponseFiles.length !== oldFilesLength)) {
        changes.push("piÃ¨ce jointe");
        mailDoitEtreEnvoye = true;
      }
      if (mailDoitEtreEnvoye && dossier.email) {
        const attachments = await fetchFilesFromFTP(dossier.reponseFiles);
        const html = `<div style="font-family:sans-serif;">
          Bonjour,<br>
          Votre dossier de garantie a été mis à jour.<br>
          Produit : ${dossier.produit_concerne || ""}<br>
          Date : ${(new Date()).toLocaleDateString("fr-FR")}<br>
          <ul>
            ${changes.includes("statut") ? `<li><b>Nouveau statut :</b> ${dossier.statut}</li>` : ""}
            ${changes.includes("rÃ©ponse") ? `<li><b>Réponse :</b> ${dossier.reponse || ""}</li>` : ""}
            ${changes.includes("piÃ¨ce jointe") ? `<li><b>Documents ajoutés à votre dossier.</b></li>` : ""}
          </ul>
          <br><br>L'équipe Garantie Durand<br><br>
        </div>`;
        if (!transporter) {
          console.error("[MAIL] SMTP not configured. Unable to send dossier update.");
        } else {
          await transporter.sendMail({
            from: `Garantie Durand Services <${fromEmail}>`,
            to: dossier.email,
            subject: `Mise à jour dossier garantie Durand Services`,
            html,
            attachments: attachments.map(f=>({ filename: f.filename, path: f.path }))
          });
        }
        cleanupFiles(attachments);
      }
      res.json({ success: true });
    } catch (err) {
      console.error("Erreur /api/admin/dossier/:id :", err.message || err);
      res.json({ success:false, message: err.message });
    }
  }
);

// API admin: envoie le dossier complet au fournisseur.
router.post("/admin/envoyer-fournisseur/:id",
  requireGarantieWrite,
  upload.fields([{ name: "fichiers", maxCount: 20 }, { name: "formulaire", maxCount: 1 }]),
  async (req, res) => {
    try {
      if (req.fileValidationError) {
        return res.status(400).json({ success: false, message: "Type de fichier non autorise." });
      }
      const { id } = req.params;
      const fournisseur = (req.body && req.body.fournisseur) ? String(req.body.fournisseur) : "";
      const emailDest = FOURNISSEUR_MAILS[fournisseur] || "";
      if (!emailDest) return res.json({ success:false, message:"Fournisseur inconnu" });
      let data = await readDataFTP();
      if (!Array.isArray(data)) data = [];
      const dossier = data.find(x => x.id === id);
      if (!dossier) return res.json({ success:false, message:"Dossier introuvable" });
      if (!canAccessDossier(req.garantieAuth, dossier)) {
        return res.status(403).json({ success: false, message: "Acces refuse pour ce magasin." });
      }
      const clientNom = (dossier.nom || "Client").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
      let dateStr = "";
      if (dossier.date) {
        const dt = new Date(dossier.date);
        if (!isNaN(dt)) dateStr = dt.toISOString().slice(0,10);
      }
      const nomFichier = `${clientNom}${dateStr ? "_" + dateStr : ""}`;
      const pdfBuffer = await creerPDFDemande(dossier, nomFichier);
      const attachments = [];
      attachments.push({ filename: nomFichier + ".pdf", content: pdfBuffer, contentType: "application/pdf" });
      const docs = await fetchFilesFromFTP([ ...(dossier.files || []), ...(dossier.documentsAjoutes || []), ...(dossier.reponseFiles || [] ) ]);
      for (const f of docs) attachments.push({ filename: f.filename, path: f.path });
      if (req.files && req.files.fichiers) {
        for (const f of req.files.fichiers) attachments.push({ filename: f.originalname, path: f.path });
      }
      if (req.files && req.files.formulaire && req.files.formulaire[0]) {
        const f = req.files.formulaire[0];
        attachments.push({ filename: f.originalname, path: f.path });
      }
      const magasinEmail = MAGASIN_MAILS[dossier.magasin] || "";
      const adminMsg = (req.body && req.body.message) ? String(req.body.message).trim() : "";
      const html = `<div style="font-family:sans-serif;">
        <p>Bonjour,</p>
        <p>Vous trouverez ci-joint une demande de garantie pour le produit&nbsp;: <strong>${dossier.produit_concerne || ''}</strong>.</p>
        <p><strong>RÃ©fÃ©rence produit :</strong> ${dossier.reference_piece || ''}</p>
        ${adminMsg ? `<p>${adminMsg.replace(/\n/g,'<br>')}</p>` : ''}
        <p style="margin-top:24px;font-weight:bold;">
          Merci de rÃ©pondre Ã  l'adresse mail : <a href="mailto:${magasinEmail}" style="color:#004080;text-decoration:underline;">${magasinEmail}</a>
        </p>
        <p>Cordialement,<br>L'Ã©quipe Garantie Durand Services</p>
      </div>`;
      if (!transporter) {
        console.error("[MAIL] SMTP not configured. Unable to send supplier email.");
      } else {
        await transporter.sendMail({
          from: `Garantie Durand Services <${fromEmail}>`,
          to: emailDest,
          replyTo: magasinEmail,
          subject: `Dossier de garantie ${dossier.numero_dossier || ''} - ${dossier.produit_concerne || ''}`,
          html,
          attachments
        });
      }
      cleanupFiles(docs);
      if (req.files) {
        const all = Object.values(req.files).reduce((acc, arr) => acc.concat(arr), []);
        for (const f of all) {
          if (f && f.path && fs.existsSync(f.path)) {
            try { fs.unlinkSync(f.path); } catch {}
          }
        }
      }
      res.json({ success:true });
    } catch (err) {
      console.error("Erreur /api/admin/envoyer-fournisseur/:id :", err.message || err);
      res.json({ success:false, message: err.message });
    }
  }
);

// API admin: met a jour les champs editables du dossier.
router.post("/admin/completer-dossier/:id", requireGarantieWrite, async (req, res) => {
  try {
    const { id } = req.params;
const cleanId = decodeURIComponent(String(id || "")).trim();

let data = await readDataFTP();
if (!Array.isArray(data)) data = [];

const dossier = data.find(x => String(x.id || "").trim() === cleanId);

if (!dossier) {
  // debug utile (à garder en prod, ça ne fuite rien de sensible)
  console.warn("[GARANTIE] Dossier introuvable", { cleanId, sampleIds: data.slice(0, 5).map(d => d.id) });
  return res.json({ success:false, message:"Dossier introuvable" });
}
    if (!canAccessDossier(req.garantieAuth, dossier)) {
      return res.status(403).json({ success: false, message: "Acces refuse pour ce magasin." });
    }
    const editableFields = [
      "nom","numero_compte_client","email","magasin","marque_produit","produit_concerne",
      "reference_piece","quantite_posee","immatriculation",
      "marque_vehicule","modele_vehicule","num_serie",
      "premiere_immat","date_pose","date_constat","km_pose",
      "km_constat","bl_pose","bl_constat","probleme_rencontre"
    ];
    editableFields.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        dossier[field] = req.body[field];
      }
    });
    await writeDataFTP(data);
    res.json({ success:true });
  } catch (err) {
    console.error("Erreur /api/admin/completer-dossier/:id :", err.message || err);
    res.json({ success:false, message: err.message });
  }
});

// Sert un formulaire PDF autorise par son nom.
router.get("/templates/:name", (req, res) => {
  const allowed = {
    "FICHE_GARANTIE_FEBI.pdf": path.join(__dirname, "formulaire", "FICHE_GARANTIE_FEBI.pdf"),
    "formulaire_garantie_metelli.pdf": path.join(__dirname, "formulaire", "formulaire_garantie_metelli.pdf"),
    "Formulaire_EFI.pdf": path.join(__dirname, "formulaire", "Formulaire_EFI.pdf"),
    "FORMULAIRE_MAGNETI.pdf": path.join(__dirname, "formulaire", "FORMULAIRE_MAGNETI.pdf"),
    "FORMULAIRE_QH.pdf": path.join(__dirname, "formulaire", "FORMULAIRE_QH.pdf"),
    "DEMANDE_RIAL.pdf": path.join(__dirname, "formulaire", "DEMANDE_RIAL.pdf"),
    "Formulaire_ AUTOGAMMA.pdf": path.join(__dirname, "formulaire", "Formulaire_ AUTOGAMMA.pdf"),
    "Formulaire_delphi.pdf": path.join(__dirname, "formulaire", "Formulaire_delphi.pdf"),
    "FORMULAIRE_ms.pdf": path.join(__dirname, "formulaire", "FORMULAIRE_ms.pdf"),
    "Formulaire_ngk.pdf": path.join(__dirname, "formulaire", "Formulaire_ngk.pdf"),
    "Formulaire_nrf.pdf": path.join(__dirname, "formulaire", "Formulaire_nrf.pdf"),
    "Formulaire_SEIM.pdf": path.join(__dirname, "formulaire", "Formulaire_SEIM.pdf"),
  };
  const filePath = allowed[req.params.name];
  if (!filePath) return res.status(404).send("Formulaire non trouvÃ©");
  res.sendFile(filePath);
});

// API admin: renvoie la liste des dossiers.
router.get("/admin/dossiers", requireGarantieRead, async (req, res) => {
  try {
    const data = await readDataFTP();
    const dossiers = Array.isArray(data) ? data : [];
    const filtered = dossiers.filter((d) => canAccessDossier(req.garantieAuth, d));
    res.json(filtered);
  } catch (err) {
    console.error("Erreur /api/admin/dossiers :", err.message || err);
    res.status(500).json([]);
  }
});

// API client : renvoie les dossiers du compte connecté (authentification requise).
// L'utilisateur doit être connecté (session garantieAuth) ; le numéro de compte
// passé en query doit correspondre à celui enregistré dans la session, sauf pour
// les admins/super qui peuvent consulter n'importe quel compte.
router.get("/mes-dossiers", requireGarantieRead, async (req, res) => {
  try {
    const auth = req.garantieAuth;
    const nccRaw = (req.query.numero_compte_client || "").toString().trim();
    if (!nccRaw) return res.json([]);

    const ncc = nccRaw.toLowerCase();
    const data = await readDataFTP();

    const dossiers = (Array.isArray(data) ? data : []).filter(d => {
      // Vérification appartenance magasin (admin/super voient tout leur scope)
      if (!canAccessDossier(auth, d)) return false;
      // Si non-admin : filtrer en plus sur le numéro de compte client
      if (!auth.isAdmin && !auth.isSuper) {
        const v = (d && d.numero_compte_client != null)
          ? String(d.numero_compte_client).trim().toLowerCase()
          : "";
        if (v !== ncc) return false;
      }
      return true;
    });

    // Ne retourner que les champs nécessaires côté client (pas de données internes)
    const safe = dossiers.map(d => ({
      id: d.id,
      date: d.date,
      statut: d.statut,
      magasin: d.magasin,
      marque_produit: d.marque_produit,
      produit_concerne: d.produit_concerne,
      numero_compte_client: d.numero_compte_client,
      nom: d.nom,
      email: d.email,
    }));

    res.json(safe);
  } catch (err) {
    console.error("Erreur /api/mes-dossiers :", err.message || err);
    res.status(500).json([]);
  }
});

// Téléchargement d'un fichier stocké sur le FTP (authentification + contrôle propriétaire).
// Le fichier doit appartenir à un dossier accessible par l'utilisateur connecté.
router.get("/download/:file", requireGarantieRead, async (req, res) => {
  try {
    const auth = req.garantieAuth;
    const raw = req.params.file;
    const fileParam = decodeURIComponent(raw || "");
    if (
      !fileParam ||
      fileParam.includes("/") ||
      fileParam.includes("\\") ||
      fileParam.includes("\0") ||
      fileParam.includes("..")
    ) {
      return res.status(400).send("Bad filename");
    }

    // Vérification que le fichier appartient bien à un dossier accessible par cet utilisateur
    const data = await readDataFTP();
    const dossiers = Array.isArray(data) ? data : [];
    const ownsFile = dossiers.some(d => {
      if (!canAccessDossier(auth, d)) return false;
      // Chercher le nom de fichier dans toutes les sections pièces-jointes du dossier
      const allFiles = [
        ...(d.files || []),
        ...(d.reponseFiles || []),
        ...(d.documentsAjoutes || []),
      ];
      return allFiles.some(f => {
        const name = typeof f === "string" ? f : (f?.url || f?.name || "");
        return String(name).split("/").pop() === fileParam;
      });
    });

    if (!ownsFile) {
      return res.status(403).send("Accès refusé.");
    }

    const remotePath = path.posix.join(UPLOADS_FTP, fileParam);
    await streamFTPFileToRes(res, remotePath, fileParam);
  } catch (err) {
    console.error("Erreur /download/:file :", err.message || err);
    if (!res.headersSent) res.status(500).send("Erreur interne.");
  }
});

// Auth admin simple par mot de passe (variables d'env).
router.post("/admin/login", garantieLoginLimiter, (req, res) => {
  const pw = trimPw(req.body?.password || "");
  let granted = null;

  // Super-admin (toutes actions)
  const superPass = trimPw(envGetAny(["superadmin-pass", "SUPERADMIN_PASS", "GARANTIE_SUPERADMIN_PASS"]));
  if (superPass && pw === superPass) {
    granted = {
      isSuper: true,
      isAdmin: true,
      isLimited: false,
      magasin: null,
      multiMagasins: null,
      defaultMagasin: null,
    };
  }

  // Admin (gestion dossiers, pas suppression)
  if (!granted) {
    const adminPass = trimPw(envGetAny(["admin-pass", "ADMIN_PASS", "GARANTIE_ADMIN_PASS"]));
    if (adminPass && pw === adminPass) {
      granted = {
        isSuper: false,
        isAdmin: true,
        isLimited: false,
        magasin: null,
        multiMagasins: null,
        defaultMagasin: null,
      };
    }
  }

  // Profils "limited" (multi magasins / lecture seule selon regles)
  if (!granted) {
    const remondLimited = trimPw(envGetAny(["magasin-Remond-limited", "MAGASIN_REMOND_LIMITED"]));
    if (remondLimited && pw === remondLimited) {
      granted = {
        isSuper: false,
        isAdmin: false,
        isLimited: true,
        magasin: null,
        multiMagasins: ["Gleize", "Les Echets", "Chassieu"],
        defaultMagasin: "Remond",
      };
    }
  }

  if (!granted) {
    const castyLimited = trimPw(envGetAny(["magasin-Casty-limited", "MAGASIN_CASTY_LIMITED"]));
    if (castyLimited && pw === castyLimited) {
      granted = {
        isSuper: false,
        isAdmin: false,
        isLimited: true,
        magasin: null,
        multiMagasins: ["Gleize", "Les Echets"],
        defaultMagasin: "Les Echets",
      };
    }
  }

  if (!granted) {
    const barretLimited = trimPw(envGetAny(["magasin-Barret-limited", "MAGASIN_BARRET_LIMITED"]));
    if (barretLimited && pw === barretLimited) {
      granted = {
        isSuper: false,
        isAdmin: false,
        isLimited: true,
        magasin: "Gleize",
        multiMagasins: null,
        defaultMagasin: "Gleize",
      };
    }
  }

  if (!granted) {
    const chassieuLimited = trimPw(envGetAny(["magasin-Chassieu-limited", "MAGASIN_CHASSIEU_LIMITED"]));
    if (chassieuLimited && pw === chassieuLimited) {
      granted = {
        isSuper: false,
        isAdmin: false,
        isLimited: true,
        magasin: "Chassieu",
        multiMagasins: null,
        defaultMagasin: "Chassieu",
      };
    }
  }

  // Mots de passe "magasin-XXX-pass"
  if (!granted) {
    for (const magasin of MAGASINS) {
      const legacy = magasinKeyLegacy(magasin);
      const modern = magasinKeyEnv(magasin);
      const expected = trimPw(envGetAny([legacy, modern]));
      if (expected && pw === expected) {
        granted = {
          isSuper: false,
          isAdmin: false,
          isLimited: false,
          magasin,
          multiMagasins: null,
          defaultMagasin: null,
        };
        break;
      }
    }
  }

  if (!granted) {
    // Diagnostic optionnel (sans reveler les mots de passe) : activer DEBUG_AUTH=1
    if (String(process.env.DEBUG_AUTH || "").trim() === "1") {
      const diag = {
        hasSuperPass: Boolean(trimPw(envGetAny(["superadmin-pass","SUPERADMIN_PASS","GARANTIE_SUPERADMIN_PASS"]))),
        hasAdminPass: Boolean(trimPw(envGetAny(["admin-pass","ADMIN_PASS","GARANTIE_ADMIN_PASS"]))),
        hasRemondLimited: Boolean(trimPw(envGetAny(["magasin-Remond-limited","MAGASIN_REMOND_LIMITED"]))),
        hasCastyLimited: Boolean(trimPw(envGetAny(["magasin-Casty-limited","MAGASIN_CASTY_LIMITED"]))),
        hasBarretLimited: Boolean(trimPw(envGetAny(["magasin-Barret-limited","MAGASIN_BARRET_LIMITED"]))),
        hasChassieuLimited: Boolean(trimPw(envGetAny(["magasin-Chassieu-limited","MAGASIN_CHASSIEU_LIMITED"]))),
        magasinsConfigured: MAGASINS.filter((m) => Boolean(trimPw(envGetAny([magasinKeyLegacy(m), magasinKeyEnv(m)])))),
        sampleExpectedEnvNames: {
          annemasse: [magasinKeyLegacy("Annemasse"), magasinKeyEnv("Annemasse")],
          bourgoinJallieu: [magasinKeyLegacy("Bourgoin-Jallieu"), magasinKeyEnv("Bourgoin-Jallieu")],
          saintMartinDheres: [magasinKeyLegacy("Saint-martin-d-heres"), magasinKeyEnv("Saint-martin-d-heres")],
        }
      };
      return res.status(401).json({ success:false, message:"Mot de passe incorrect", diag });
    }
    return res.status(401).json({ success: false, message: "Mot de passe incorrect" });
  }

// Régénérer la session pour prévenir le session fixation, tout en préservant siteAuthed
const prevSiteAuthed = req.session?.siteAuthed;
const prevSiteAuthedAt = req.session?.siteAuthedAt;

req.session.regenerate((regenErr) => {
  if (regenErr) {
    return res.status(500).json({ success: false, message: "Session regeneration failed" });
  }
  // Restaurer siteAuthed si l'utilisateur était déjà authentifié sur le site
  if (prevSiteAuthed) {
    req.session.siteAuthed = prevSiteAuthed;
    req.session.siteAuthedAt = prevSiteAuthedAt;
  }
  req.session.garantieAuth = {
    ...granted,
    loginAt: new Date().toISOString(),
  };
  return req.session.save((saveErr) => {
    if (saveErr) {
      return res.status(500).json({ success: false, message: "Session save failed" });
    }
    return res.json({ success: true, ...granted });
  });
});
});

router.post("/admin/logout", requireGarantieRead, (req, res) => {
  req.session.garantieAuth = null;
  req.session.save(() => res.sendStatus(204));
});

// API admin: supprime une piece jointe d'un dossier.
router.post("/admin/dossier/:id/delete-file", requireGarantieWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const { section, url } = req.body || {};
    if (!section || !url) {
      return res.json({ success: false, message: "ParamÃ¨tres manquants." });
    }
    let data = await readDataFTP();
    if (!Array.isArray(data)) data = [];
    const dossier = data.find(d => d.id === id);
    if (!dossier) {
      return res.json({ success: false, message: "Dossier introuvable." });
    }
    if (!canAccessDossier(req.garantieAuth, dossier)) {
      return res.status(403).json({ success: false, message: "Acces refuse pour ce magasin." });
    }
    const allowed = ["files", "reponseFiles", "documentsAjoutes"];
    if (!allowed.includes(section)) {
      return res.json({ success: false, message: "Section invalide." });
    }
    const arr = Array.isArray(dossier[section]) ? dossier[section] : [];
    const idx = arr.findIndex(f => f && f.url === url);
    if (idx === -1) {
      return res.json({ success: false, message: "Fichier introuvable dans le dossier." });
    }
    const removed = arr.splice(idx, 1)[0];
    dossier[section] = arr;
    await writeDataFTP(data);
    await deleteFilesFromFTP([removed.url]);
    res.json({ success: true });
  } catch (err) {
    console.error("Erreur /api/admin/dossier/:id/delete-file :", err.message || err);
    res.json({ success: false, message: err.message || "Erreur interne." });
  }
});

// API admin super: supprime le dossier et ses fichiers.
router.delete("/admin/dossier/:id", requireGarantieSuper, async (req, res) => {
  try {
    const { id } = req.params;
    let data = await readDataFTP();
    if (!Array.isArray(data)) data = [];
    const index = data.findIndex(d => d.id === id);
    if (index === -1) {
      return res.status(404).json({ success: false, message: "Dossier introuvable." });
    }
    const dossier = data[index];
    const filesToDelete = [];
    (dossier.files || []).forEach(f => f && f.url && filesToDelete.push(f.url));
    (dossier.reponseFiles || []).forEach(f => f && f.url && filesToDelete.push(f.url));
    (dossier.documentsAjoutes || []).forEach(f => f && f.url && filesToDelete.push(f.url));
    data.splice(index, 1);
    await writeDataFTP(data);
    if (filesToDelete.length) {
      try {
        await deleteFilesFromFTP(filesToDelete);
      } catch (err) {
        console.warn("[DELETE DOSSIER] Erreur pendant deleteFilesFromFTP :", err.message || err);
      }
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("Erreur /api/admin/dossier/:id (DELETE) :", err.message || err);
    return res.status(500).json({ success: false, message: err.message || "Erreur interne lors de la suppression." });
  }
});

// API admin: export Excel des dossiers (annee optionnelle).
router.get("/admin/export-excel", requireGarantieRead, async (req, res) => {
  try {
    const dataRaw = await readDataFTP();
    const data = (Array.isArray(dataRaw) ? dataRaw : []).filter((d) => canAccessDossier(req.garantieAuth, d));

    const yearRaw = (req.query && req.query.year) ? String(req.query.year) : "";
    const year = yearRaw ? parseInt(yearRaw, 10) : NaN;

    const filtered = (Number.isFinite(year) && year >= 2000 && year <= 2100)
      ? (Array.isArray(data) ? data.filter(d => {
          if (!d || !d.date) return false;
          const dt = new Date(d.date);
          if (Number.isNaN(dt.getTime())) return false;
          return dt.getFullYear() === year;
        }) : [])
      : (Array.isArray(data) ? data : []);
    const columns = [
      { header: "Date", key: "date" },
      { header: "Magasin", key: "magasin" },
      { header: "Marque du produit", key: "marque_produit" },
      { header: "Produit concernÃ©", key: "produit_concerne" },
      { header: "RÃ©fÃ©rence de la piÃ¨ce", key: "reference_piece" },
      { header: "ProblÃ¨me rencontrÃ©", key: "probleme_rencontre" },
      { header: "Nom client", key: "nom" },
      { header: "Email", key: "email" },
      { header: "Statut", key: "statut" },
      { header: "RÃ©ponse", key: "reponse" },
      { header: "NumÃ©ro d'avoir", key: "numero_avoir" },
    ];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(Number.isFinite(year) ? ("Demandes " + year) : "Demandes globales");
    ws.columns = columns;
    filtered.forEach(d => {
      const obj = {};
      columns.forEach(col => {
        let val = d[col.key] || "";
        if (col.key === "date" && val) val = new Date(val).toLocaleDateString("fr-FR");
        if (typeof val === "string") val = val.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
        obj[col.key] = val;
      });
      ws.addRow(obj);
    });
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="dossiers-' + (Number.isFinite(year) ? String(year) : "globales") + '.xlsx"'
    );
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Erreur /api/admin/export-excel :", err.message || err);
    if (!res.headersSent) res.status(500).send("Erreur lors de la gÃ©nÃ©ration du fichier Excel.");
  }
});

// Sert la page admin.
router.get("/admin", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "..", "garantie", "admin-garantie.html"));
});
// Sert la page publique de suivi (ou redirige).
router.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const p = path.join(__dirname, "..", "garantie", "suivi.html");
  if (fs.existsSync(p)) return res.sendFile(p);
  return res.redirect("/admin");
});
// Demarre le serveur et verifie la config mail.


export default router;

