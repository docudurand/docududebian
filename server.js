// serveur principal (Express) pour tous les formulaires et APIs

import express from "express";
import multer from "multer";
import cors from "cors";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
import util from "node:util";
import axios from "axios";
import { transporter, fromEmail } from "./mailer.js";
import crypto from "crypto";
import dayjs from "dayjs";
import PDFDocument from "pdfkit";
import { PDFDocument as PDFLib, StandardFonts, rgb } from "pdf-lib";
import ftp from "basic-ftp";
import ExcelJS from "exceljs";
import QRCode from "qrcode";
import session from "express-session";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mailLogsRouter from "./routes/mail-logs.js";
import adminEditorRouter from "./routes/admin-json-editor.js";
import * as ftpStorage from "./ftpStorage.js";
import { seedFournisseurPl, seedSiteIdentificationOe, seedFournisseurVl } from "./jsonSeedFromHtml.js";

import * as stats from "./stats.js";
import * as visits from "./visits.js";
import formtelevente from "./formtelevente/index.js";
import formulairePiece from "./formulaire-piece/index.js";
import formulairePiecePL from "./formulaire-piecepl/index.js";
import formulairePneu from "./formulaire-pneu/index.js";
import suiviDossier from "./suivi-dossier/index.js";
import loansRouter from "./pretvehiculed/server-loans-ftp.js";
import atelierRouter from "./atelier/index.js";
import presences from "./routes/presences.js";
import ramasseRouter from "./routes/ramasse.js";
import kilometrageRouter from "./routes/kilometrage.js";
import garantieRouter from "./garantie-module/routes.js";
import "./mailInlineWorker.js";

// Chargement des variables d'environnement (via dotenv/config import)
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err);
});

// Chemins utilitaires pour servir des fichiers statiques
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Instance Express principale
const app = express();
app.disable("x-powered-by");

app.set("trust proxy", 1);

// Liste blanche CORS
const ALLOWED_ORIGINS_EXACT = new Set([
  "https://www.documentsdurand.fr",
  "https://documentsdurand.fr",
  "https://imaginatevie-hamster-040331.netlify.app",
  "",
]);

// Cette fonction sert a verifier une origine CORS
function isAllowedOrigin(origin) {
  if (!origin) return true;
  const o = String(origin).trim();

  if (ALLOWED_ORIGINS_EXACT.has(o)) return true;

  if (/^https:\/\/[^\/]+\.wixsite\.com$/i.test(o)) return true;
  if (/^https:\/\/[^\/]+\.wix\.com$/i.test(o)) return true;
  if (/^https:\/\/[^\/]+\.editorx\.io$/i.test(o)) return true;

  if (/^http:\/\/192\.168\.1\.40(?::\d+)?$/i.test(o)) return true;

  if (/^https:\/\/[^\/]+\.netlify\.app$/i.test(o)) return true;

  if (/^http:\/\/localhost(?::\d+)?$/i.test(o)) return true;
  if (/^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(o)) return true;

  return false;
}

// Parametres CORS
const corsOptions = {
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);

    console.warn("[CORS] blocked origin:", origin);
    return cb(null, false);
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Token", "X-Requested-With", "X-Request-Id"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(helmet({ contentSecurityPolicy: false }));

const SESSION_SECRET =
  String(process.env.SESSION_SECRET || "").trim() ||
  String(process.env.ADMIN_SECRET_KEY || "").trim();

if (!SESSION_SECRET || SESSION_SECRET === "change-me") {
  throw new Error("Missing strong SESSION_SECRET (or ADMIN_SECRET_KEY)");
}

app.set("trust proxy", 1);

app.use(session({
  name: "dd_admin_session",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: "auto",
  }
}));

// Log uniquement les erreurs 5xx avec temps de traitement
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    if (res.statusCode < 500) return;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const url = req.originalUrl || req.url || "";
    console.error(`[HTTP] ${req.method} ${url} -> ${res.statusCode} ${elapsedMs.toFixed(1)}ms`);
  });
  next();
});
app.use((req, res, next) => {

const ALLOWED_FRAME_ANCESTORS = [
  "'self'",
  "http://192.168.1.40",
  "http://192.168.1.40:80",
  "http://localhost",
  "http://127.0.0.1",

  // Wix / EditorX (si encore utilisés)
  "https://documentsdurand.wixsite.com",
  "https://*.wixsite.com",
  "https://*.wix.com",
  "https://*.editorx.io",

  // Domaine public (pour plus tard)
  "https://documentsdurand.fr",
  "https://www.documentsdurand.fr",
];

const FRAME_ANCESTORS_VALUE = "frame-ancestors " + ALLOWED_FRAME_ANCESTORS.join(" ");

  const ensureFrameAncestors = (cspValue) => {
    const v = String(cspValue || "").trim();
    if (!v) return FRAME_ANCESTORS_VALUE;

    if (/frame-ancestors/i.test(v)) {

      return v.replace(/frame-ancestors[^;]*/i, FRAME_ANCESTORS_VALUE);
    }

    return v.replace(/\s*;?\s*$/, "; ") + FRAME_ANCESTORS_VALUE;
  };

  if (!res.getHeader("Content-Security-Policy")) {
    res.setHeader("Content-Security-Policy", FRAME_ANCESTORS_VALUE);
  }

  const _setHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    const key = String(name || "").toLowerCase();

    if (key === "content-security-policy") {
      return _setHeader(name, ensureFrameAncestors(value));
    }

    if (key === "x-frame-options") {
      return;
    }

    return _setHeader(name, value);
  };

  res.removeHeader("X-Frame-Options");

  next();
});

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
// Routes pour lecture des logs mails
app.use(mailLogsRouter);

// bloque si une variable d'environnement manque
function mustEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

// Appel Google Apps Script pour le module livraison
async function callNavetteGAS(action, params = {}) {
  const url = mustEnv("NAVETTE_GAS_URL");
  const key = mustEnv("NAVETTE_API_KEY");

  const payload = new URLSearchParams({ action, key, ...params });

  const { data } = await axios.post(url, payload.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 60000,
  });

  return data;
}

// ---- API LIVRAISON (import/scan/livraison) ----
const NAVETTE_ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);
const NAVETTE_ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);
const NAVETTE_MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
};

function isAllowedNavettePhoto(file) {
  const mimeType = String(file?.mimetype || "").toLowerCase();
  const ext = String(path.extname(file?.originalname || "") || "").toLowerCase();
  return NAVETTE_ALLOWED_MIME.has(mimeType) && NAVETTE_ALLOWED_EXT.has(ext);
}

function getSafeNavettePhotoExt(file) {
  const ext = String(path.extname(file?.originalname || "") || "").toLowerCase();
  if (NAVETTE_ALLOWED_EXT.has(ext)) return ext;
  return NAVETTE_MIME_TO_EXT[String(file?.mimetype || "").toLowerCase()] || ".jpg";
}

const navetteUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 }, // 12 Mo
  fileFilter: (req, file, cb) => {
    if (isAllowedNavettePhoto(file)) return cb(null, true);
    req.fileValidationError = "photo_type_not_allowed";
    return cb(null, false);
  },
});

app.post("/api/navette/import", async (req, res) => {
  try {
    const { magasin, bons, tourneeId } = req.body || {};
    const data = await callNavetteGAS("importList", {
      magasin: String(magasin || ""),
      bons: String(bons || ""),
      tourneeId: String(tourneeId || ""),
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

app.post("/api/navette/valider", async (req, res) => {
  try {
    const {
      tourneeId,
      magasin,
      livreurId,
      bon,
      tournee,
      codeTournee,
      gpsLat,
      gpsLng,
      gpsAcc,
      gpsTs,
    } = req.body || {};

    const params = {
      tourneeId: String(tourneeId || ""),
      magasin: String(magasin || ""),
      livreurId: String(livreurId || ""),
      bon: String(bon || ""),
      tournee: String(tournee || ""),
      codeTournee: String(codeTournee || ""),
    };

    const hasLat = gpsLat !== undefined && gpsLat !== null && String(gpsLat).trim() !== "";
    const hasLng = gpsLng !== undefined && gpsLng !== null && String(gpsLng).trim() !== "";
    if (hasLat && hasLng) {
      params.gpsLat = String(gpsLat);
      params.gpsLng = String(gpsLng);
      if (gpsAcc !== undefined && gpsAcc !== null && String(gpsAcc).trim() !== "") params.gpsAcc = String(gpsAcc);
      if (gpsTs !== undefined && gpsTs !== null && String(gpsTs).trim() !== "") params.gpsTs = String(gpsTs);
    }

    const data = await callNavetteGAS("scanValider", params);
    res.json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

app.post("/api/navette/livrer", async (req, res) => {
  try {
    const {
      tourneeId,
      magasin,
      livreurId,
      bon,
      tournee,
      codeTournee,
      gpsLat,
      gpsLng,
      gpsAcc,
      gpsTs,
    } = req.body || {};

    const params = {
      tourneeId: String(tourneeId || ""),
      magasin: String(magasin || ""),
      livreurId: String(livreurId || ""),
      bon: String(bon || ""),
      tournee: String(tournee || ""),
      codeTournee: String(codeTournee || ""),
    };

    const hasLat = gpsLat !== undefined && gpsLat !== null && String(gpsLat).trim() !== "";
    const hasLng = gpsLng !== undefined && gpsLng !== null && String(gpsLng).trim() !== "";
    if (hasLat && hasLng) {
      params.gpsLat = String(gpsLat);
      params.gpsLng = String(gpsLng);
      if (gpsAcc !== undefined && gpsAcc !== null && String(gpsAcc).trim() !== "") params.gpsAcc = String(gpsAcc);
      if (gpsTs !== undefined && gpsTs !== null && String(gpsTs).trim() !== "") params.gpsTs = String(gpsTs);
    }

    const data = await callNavetteGAS("scanLivrer", params);
    res.json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});


app.post("/api/navette/set-lieu", async (req, res) => {
  try {
    const { magasin, bon, row, gpsLat, gpsLng, gpsLieu } = req.body || {};
    const data = await callNavetteGAS("setLieuName", {
      magasin: String(magasin || ""),
      bon: String(bon || ""),
      row: String(row || ""),
      gpsLat: String(gpsLat || ""),
      gpsLng: String(gpsLng || ""),
      gpsLieu: String(gpsLieu || ""),
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

const bulkJobs = new Map();

function makeJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Essaie de lire les coordonnees GPS depuis plusieurs formats
function extractGps(body) {
  const b = body || {};
  const g = (b.gps && typeof b.gps === "object") ? b.gps : {};

  const lat = (b.gpsLat ?? g.gpsLat ?? b.lat ?? g.lat ?? b.latitude ?? g.latitude ?? "");
  const lng = (b.gpsLng ?? g.gpsLng ?? b.lng ?? g.lng ?? b.longitude ?? g.longitude ?? "");
  const acc = (b.gpsAcc ?? g.gpsAcc ?? b.acc ?? g.acc ?? b.accuracy ?? g.accuracy ?? "");
  const ts  = (b.gpsTs  ?? g.gpsTs  ?? b.ts  ?? g.ts  ?? b.timestamp ?? g.timestamp ?? "");
  return { lat, lng, acc, ts };
}

// Parse une liste de bons depuis texte ou tableau
function parseBonsList(bons) {
  if (Array.isArray(bons)) return bons.map(x => String(x).trim()).filter(Boolean);
  return String(bons || "")
    .split(/[\n,;\s\t\r]+/g)
    .map(x => x.trim())
    .filter(Boolean);
}

app.post("/api/navette/bulk", async (req, res) => {
  try {
    const b = req.body || {};

    const mode = String(b.mode || "").trim().toLowerCase() === "livrer" ? "livrer" : "charger";
    const magasin = String(b.magasin || "").trim().toUpperCase();
    const livreurId = String(b.livreurId || b.livreur || "").trim();
    const tourneeId = String(b.tourneeId || "").trim();
    const tournee = String(b.tournee || "").trim();
    const codeTournee = String(b.codeTournee || "").trim();

    const list = parseBonsList(b.bons);

    if (!magasin || !livreurId || !list.length) {
      return res.status(400).json({ success:false, error:"bad_request", details:"magasin/livreurId/bons requis" });
    }

    const jobId = makeJobId();
    bulkJobs.set(jobId, { status:"queued", createdAt: new Date().toISOString(), count: list.length });

    res.status(202).json({ success:true, queued:true, jobId, count: list.length });

    setImmediate(async () => {
      const job = bulkJobs.get(jobId);
      if (!job) return;

      job.status = "running";
      job.startedAt = new Date().toISOString();

      try {
        const gps = extractGps(b);
        const gpsLat = gps.lat;
        const gpsLng = gps.lng;
        const gpsAcc = gps.acc;
        const gpsTs  = gps.ts;

        const params = {
          mode,
          magasin,
          livreurId,
          tourneeId,
          tournee,
          codeTournee,

          bons: list.join(","),
        };

        const hasLat = gpsLat !== undefined && gpsLat !== null && String(gpsLat).trim() !== "";
        const hasLng = gpsLng !== undefined && gpsLng !== null && String(gpsLng).trim() !== "";
        if (hasLat && hasLng) {
          params.gpsLat = String(gpsLat);
          params.gpsLng = String(gpsLng);
          if (gpsAcc !== undefined && gpsAcc !== null && String(gpsAcc).trim() !== "") params.gpsAcc = String(gpsAcc);
          if (gpsTs  !== undefined && gpsTs  !== null && String(gpsTs).trim()  !== "") params.gpsTs  = String(gpsTs);
        }

        const data = await callNavetteGAS("bulkScan", params);

        job.status = "done";
        job.finishedAt = new Date().toISOString();
        job.ok = true;
        job.result = data;
      } catch (e) {
        job.status = "done";
        job.finishedAt = new Date().toISOString();
        job.ok = false;
        job.error = String(e?.message || e);
      }
    });

  } catch (e) {
    return res.status(500).json({ success:false, error:String(e?.message || e) });
  }
});

app.get("/api/navette/bulk/status", (req, res) => {
  const jobId = String(req.query.jobId || "").trim();
  if (!jobId) return res.status(400).json({ success:false, error:"missing_jobId" });
  const st = bulkJobs.get(jobId);
  if (!st) return res.status(404).json({ success:false, error:"unknown_jobId" });
  
  return res.json({ success:true, jobId, ...st });
});

// --- Commerce: expose televente URLs from env ---
app.get("/commerce/links.json", (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json({
    televente_bosch: process.env.COMMERCE_TELEVENTE_BOSCH_URL || "",
    televente_lubrifiant: process.env.COMMERCE_TELEVENTE_LUB_URL || ""
  });
});

app.get("/atelier/api/config", async (req, res) => {
  let client;
  const debug = String(req.query.debug || "") === "1";

  // Dossier racine FTP (utilisé ailleurs dans ce server)
  const ftpRootBase = (process.env.FTP_BACKUP_FOLDER || "/").replace(/\/$/, "");
  const remotePathEnv = String(process.env.ATELIER_DATA_PATH || "").trim();

  // Chemin par défaut : /Disque 1/service/atelier_data.json (si FTP_BACKUP_FOLDER=/Disque 1/service)
  const remotePath = remotePathEnv || `${ftpRootBase}/atelier_data.json`;

  try {
    client = await ftpClient();

    // Essaye le chemin tel quel, puis (si besoin) sans le "/" initial (certains FTP refusent les chemins absolus)
    let data = await dlJSON(client, remotePath);
    if (!data && remotePath.startsWith("/")) {
      data = await dlJSON(client, remotePath.replace(/^\/+/, ""));
    }
    if (!data || typeof data !== "object") {
      return res.status(500).json({
        ok: false,
        error: "atelier_config_not_found",
        details: debug ? { remotePathTried: remotePath } : undefined,
      });
    }

    const lignes = data.lignes || data.LIGNES || [];
    const regles = data.regles || data.REGLES || [];

    const lignesOk = Array.isArray(lignes) && lignes.length > 0;
    const reglesOk = Array.isArray(regles) && regles.length > 0;

    // Si tout est vide, c'est presque toujours un problème de chemin/FTP/JSON → on préfère une erreur explicite
    if (!lignesOk && !reglesOk) {
      return res.status(500).json({
        ok: false,
        error: "atelier_config_empty",
        details: debug
          ? { remotePathTried: remotePath, keys: Object.keys(data || {}) }
          : undefined,
      });
    }

    return res.json({ ok: true, lignes: Array.isArray(lignes) ? lignes : [], regles: Array.isArray(regles) ? regles : [] });
  } catch (e) {
    console.error("[atelier/api/config]", e?.message || e);
    return res.status(500).json({
      ok: false,
      error: "config_load_failed",
      details: debug ? String(e?.message || e) : undefined,
    });
  } finally {
    try { client?.close(); } catch {}
  }
});

app.get("/atelier/qr/:no", async (req, res) => {
  try {
    const no = String(req.params.no || "").trim();
    if (!no) return res.status(400).send("missing_no");

    const base = String(process.env.PUBLIC_BASE_URL || "").trim() || `${req.protocol}://${req.get("host")}`;
    const validationUrl = `${base.replace(/\/+$/, "")}/atelier/validation.html?no=${encodeURIComponent(no)}`;

    const png = await QRCode.toBuffer(validationUrl, { type: "png", scale: 6, margin: 1 });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(png);
  } catch (e) {
    console.error("[atelier/qr]", e?.message || e);
    return res.status(500).send("qr_error");
  }
});

async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    backoffMultiplier = 2,
    onRetry = null
  } = options;

  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Ne pas retry si c'est la dernière tentative
      if (attempt === maxRetries) {
        break;
      }

      // Calculer le délai avec backoff exponentiel
      const delay = Math.min(
        initialDelay * Math.pow(backoffMultiplier, attempt),
        maxDelay
      );

      // Log et callback optionnel
      const attemptNum = attempt + 1;
      console.log(`[RETRY] Attempt ${attemptNum}/${maxRetries} failed, retrying in ${delay}ms...`, {
        error: error?.message || String(error),
        code: error?.code
      });

      if (onRetry) {
        try {
          onRetry(attempt, error, delay);
        } catch (e) {
          console.error("[RETRY] onRetry callback error:", e);
        }
      }

      // Attendre avant de réessayer
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Si on arrive ici, tous les retries ont échoué
  throw lastError;
}

// Jobs pour photos (similaire aux bulk jobs)
const PHOTO_JOBS = new Map();
function createPhotoJobId() {
  return `photo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function setPhotoJob(jobId, patch) {
  const prev = PHOTO_JOBS.get(jobId) || {};
  PHOTO_JOBS.set(jobId, { ...prev, ...patch });
}
function getPhotoJob(jobId) {
  return PHOTO_JOBS.get(jobId) || null;
}

// Nettoyage périodique des vieux jobs photo
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of PHOTO_JOBS.entries()) {
    const t = j?.createdAt || now;
    if (now - t > 24*3600*1000) PHOTO_JOBS.delete(id);
  }
}, 30*60*1000).unref?.();

// 📸 Preuve photo de livraison : upload sur FTP puis association dans Google Sheet (version async)
// Reçoit un multipart/form-data : photo + champs (tourneeId, magasin, livreurId, tournee, codeTournee, bons JSON)
app.post("/api/navette/proof-photo", navetteUpload.single("photo"), async (req, res) => {
  try {
    if (req.fileValidationError) {
      return res.status(400).json({ success: false, error: "photo_type_not_allowed" });
    }
    const f = req.file;
    if (!f) return res.status(400).json({ success:false, error:"photo_manquante" });

    if (!isAllowedNavettePhoto(f)) {
      try { fs.unlinkSync(f.path); } catch {}
      return res.status(400).json({ success: false, error: "photo_type_not_allowed" });
    }

    const tourneeId   = String(req.body?.tourneeId || "").trim();
    const magasin     = String(req.body?.magasin || "").trim().toUpperCase();
    const livreurId   = String(req.body?.livreurId || "").trim();
    const tournee     = String(req.body?.tournee || "").trim();
    const codeTournee = String(req.body?.codeTournee || "").trim();

    let bons = [];
    try { bons = JSON.parse(String(req.body?.bons || "[]")); } catch { bons = []; }
    if (!Array.isArray(bons)) bons = [];
    bons = bons.map(x => String(x).trim()).filter(Boolean);

    if (!magasin || !livreurId || !bons.length) {
      try { fs.unlinkSync(f.path); } catch {}
      return res.status(400).json({ success:false, error:"bad_request", details:"magasin/livreurId/bons requis" });
    }

    const ext = getSafeNavettePhotoExt(f);
    const safe = (s) => String(s || "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40);

    const now = new Date();
    const y = String(now.getFullYear());
    const m = String(now.getMonth()+1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");

    const baseDirRaw = String(process.env.NAVETTE_FTP_DIR || "navette-preuves").trim() || "navette-preuves";
    const baseDir = normFtpPath_(baseDirRaw);

    // Dossier daté: baseDir/YYYY/MM/DD
    const remoteDirWanted = path.posix.join(baseDir, y, m, d);

    const fileName = `${safe(magasin)}_${safe(livreurId)}_${safe(tourneeId || codeTournee || tournee || "tournee")}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}${ext}`;
    const remotePathWanted = path.posix.join(remoteDirWanted, fileName);

    // Créer un job et retourner immédiatement
    const jobId = createPhotoJobId();
    setPhotoJob(jobId, { 
      status: "queued", 
      createdAt: Date.now(), 
      count: bons.length 
    });

    // Retourner immédiatement au client
    res.status(202).json({ 
      success: true, 
      queued: true, 
      jobId, 
      count: bons.length,
      message: "Photo en cours d'envoi en arrière-plan"
    });

    // Traiter l'upload en arrière-plan
    setImmediate(async () => {
      let client;
      let uploadAttempts = 0;
      let gasAttempts = 0;
      
      try {
        setPhotoJob(jobId, { status: "uploading", attempts: 0 });
        
        // ÉTAPE 1: Upload FTP avec retry
        let remotePath, photoUrl;
        await retryWithBackoff(async () => {
          uploadAttempts++;
          
          // Fermer le client précédent si retry
          if (client) {
            try { await client.close(); } catch {}
          }
          
          client = await ftpClient();

          // 1) crée le dossier (compatible chemins absolus/relatifs)
          const remoteDir = await ensureDirSafe_(client, remoteDirWanted);

          // 2) upload (idem)
          remotePath = await uploadFromSafe_(client, f.path, path.posix.join(remoteDir, fileName));
          
          // URL publique (si configurée) sinon on renvoie le chemin FTP
          const pubBase = String(process.env.NAVETTE_FTP_PUBLIC_BASE_URL || process.env.FTP_PUBLIC_BASE_URL || "").trim();
          photoUrl = pubBase
            ? (pubBase.replace(/\/+$/,"") + "/" + remotePath.replace(/^\/+/, ""))
            : remotePath;
            
          console.log(`[NAVETTE][proof-photo][${jobId}] FTP upload success on attempt ${uploadAttempts}`);
        }, {
          maxRetries: 3,
          initialDelay: 2000,
          maxDelay: 10000,
          onRetry: (attempt, error) => {
            setPhotoJob(jobId, { 
              status: "uploading", 
              attempts: attempt + 1,
              lastError: error?.message || String(error)
            });
          }
        });

        // Nettoyage du tmp local après upload réussi
        try { fs.unlinkSync(f.path); } catch {}

        setPhotoJob(jobId, { 
          status: "linking", 
          photoUrl,
          uploadAttempts 
        });

        // ÉTAPE 2: Association Google Sheet avec retry
        await retryWithBackoff(async () => {
          gasAttempts++;
          
          const linkResp = await callNavetteGAS("setPhotoForBons", {
            tourneeId,
            magasin,
            livreurId,
            tournee,
            codeTournee,
            photoUrl,
            bons: JSON.stringify(bons),
          });

          // Si GAS répond mais n'a rien mis à jour, on enregistre un warning
          if (linkResp && linkResp.success && Number(linkResp.updated||0) <= 0) {
            setPhotoJob(jobId, { 
              status: "done", 
              doneAt: Date.now(), 
              photoUrl,
              uploadAttempts,
              gasAttempts,
              warning: "sheet_link_not_applied",
              missing: linkResp.missing || []
            });
          } else {
            setPhotoJob(jobId, { 
              status: "done", 
              doneAt: Date.now(), 
              photoUrl,
              uploadAttempts,
              gasAttempts,
              updated: linkResp?.updated || 0
            });
          }
          
          console.log(`[NAVETTE][proof-photo][${jobId}] GAS link success on attempt ${gasAttempts}, updated ${linkResp?.updated || 0} rows`);
        }, {
          maxRetries: 3,
          initialDelay: 1000,
          maxDelay: 8000,
          onRetry: (attempt, error) => {
            setPhotoJob(jobId, { 
              status: "linking", 
              photoUrl,
              uploadAttempts,
              gasAttempts: attempt + 1,
              lastError: error?.message || String(error)
            });
          }
        });

      } catch (e) {
        console.error(`[NAVETTE][proof-photo][${jobId}] Final error after all retries:`, {
          error: e?.message || String(e),
          code: e?.code,
          uploadAttempts,
          gasAttempts
        });
        
        setPhotoJob(jobId, { 
          status: "error", 
          doneAt: Date.now(),
          uploadAttempts,
          gasAttempts,
          error: String(e?.message || e),
          errorCode: e?.code
        });
        
        // Nettoyer le fichier en cas d'erreur finale
        try { if (f?.path) fs.unlinkSync(f.path); } catch {}
      } finally {
        try { client?.close?.(); } catch {}
      }
    });
  } catch (e) {
    console.error("[NAVETTE][proof-photo] error", e);
    // Si erreur avant la mise en queue, nettoyer et retourner erreur
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch {}
    return res.status(500).json({ success:false, error: String(e?.message || e) });
  }
});

// 📊 Statut d'un job photo
app.get("/api/navette/proof-photo/status", (req, res) => {
  const jobId = String(req.query.jobId || "").trim();
  if (!jobId) return res.status(400).json({ success:false, error:"jobId manquant" });
  const job = getPhotoJob(jobId);
  if (!job) return res.status(404).json({ success:false, error:"jobId inconnu" });
  res.json({ success:true, job });
});


// 📥 Servir un fichier (photo preuve) stocké sur le FTP à partir d'un chemin enregistré en Google Sheet.
// Exemple: /api/navette/file?path=/Disque%201/navette-preuves/2026/01/28/xxx.jpg
app.get("/api/navette/file", async (req, res) => {
  let client;
  let tmp = "";
  try {
    const raw = String(req.query.path || req.query.p || "").trim();
    if (!raw) return res.status(400).json({ success:false, error:"missing_path" });

    const requested = normFtpPath_(decodeURIComponent(raw));

    const baseDirRaw = String(process.env.NAVETTE_FTP_DIR || "navette-preuves").trim() || "navette-preuves";
    const baseDir = normFtpPath_(baseDirRaw);

    const reqNoLead  = requested.replace(/^\/+/, "");
    const baseNoLead = baseDir.replace(/^\/+/, "");
    const allowed = (reqNoLead === baseNoLead) || reqNoLead.startsWith(baseNoLead + "/");
    if (!allowed) return res.status(403).json({ success:false, error:"forbidden_path" });

    client = await ftpClient();

    const ext = (path.extname(reqNoLead) || "").toLowerCase();
    tmp = tmpFile("navette_" + Date.now() + (ext || ".bin"));

    try {
      await client.downloadTo(tmp, requested);
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("550") && requested.startsWith("/")) {
        await client.downloadTo(tmp, requested.replace(/^\/+/, ""));
      } else {
        throw e;
      }
    }

    const filename = path.posix.basename(reqNoLead).replace(/"/g, "");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    if (ext) res.type(ext);

    const stream = fs.createReadStream(tmp);
    res.on("finish", () => { try { fs.unlinkSync(tmp); } catch {} });
    stream.on("error", () => { try { res.status(500).end("read_error"); } catch {} });
    stream.pipe(res);
  } catch (e) {
    console.error("[NAVETTE][file] error", e);
    try { if (tmp) fs.unlinkSync(tmp); } catch {}
    return res.status(500).json({ success:false, error:String(e?.message || e) });
  } finally {
    try { client?.close?.(); } catch {}
  }
});


app.get("/api/navette/dashboard", async (req, res) => {
  try {
    const magasin = String(req.query.magasin || "");
    const data = await callNavetteGAS("getDashboard", { magasin });
    res.json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});


app.get("/api/navette/active", async (req, res) => {
  try {
    const magasin = String(req.query.magasin || "");
    const data = await callNavetteGAS("getActiveTournee", { magasin });
    res.json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});


app.get("/api/navette/livreur", async (req, res) => {
  try {
    const tourneeId = String(req.query.tourneeId || "");
    const livreurId = String(req.query.livreurId || "");
    const magasin = String(req.query.magasin || "");
    const data = await callNavetteGAS("getLivreur", { tourneeId, livreurId, magasin });
    res.json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

app.get("/api/navette/magasins", async (req, res) => {
  try {
    const data = await callNavetteGAS("getMagasins", {});
    res.json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const PRESENCES_ADMIN_TOKEN = String(process.env.PRESENCES_LEAVES_PASSWORD || "").trim();

// Recupere le token admin
function extractAdminToken(req) {
  const headerToken = req.headers["x-admin-token"];
  if (headerToken) return { token: String(headerToken).trim(), source: "header" };

  const auth = req.headers.authorization;
  if (auth) {
    const value = String(auth).trim();
    if (value.toLowerCase().startsWith("bearer ")) {
      return { token: value.slice(7).trim(), source: "bearer" };
    }
  }

  return { token: "", source: "none" };
}

function safeTokenEqual(expected, provided) {
  const a = Buffer.from(String(expected || ""), "utf8");
  const b = Buffer.from(String(provided || ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function isAdminTokenValid(token) {
  return safeTokenEqual(ADMIN_TOKEN, String(token || "").trim());
}

function requireBackofficeAuth(req, res, next) {
  if (req.session?.siteAuthed === true) return next();

  const { token } = extractAdminToken(req);
  if (isAdminTokenValid(token)) {
    return next();
  }

  return res.status(401).json({ error: "auth_required" });
}

function requirePresencesAdminToken(req, res, next) {
  if (!PRESENCES_ADMIN_TOKEN) {
    return res.status(503).json({ error: "presences_admin_token_not_configured" });
  }
  const token = String(req.get("X-Admin-Token") || "").trim();
  if (!safeTokenEqual(PRESENCES_ADMIN_TOKEN, token)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return next();
}

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_attempts" },
});


// Fichiers statiques (public/)
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html", "htm"], index: false }));

// Login simple protege par un mot de passe (site entier)
app.post("/api/site/login", loginLimiter, (req, res) => {
  try {
    const pwd = String(req.body?.password || "");
    const expected = String(process.env.SITE_PASSWORD || "").trim();
    if (!expected) {
      return res.status(503).json({ error: "site_password_not_configured" });
    }
    if (pwd && pwd === expected) {
      return req.session.regenerate((regenErr) => {
        if (regenErr) return res.sendStatus(500);
        req.session.siteAuthed = true;
        req.session.siteAuthedAt = Date.now();
        return req.session.save((saveErr) => {
          if (saveErr) return res.sendStatus(500);
          return res.sendStatus(200);
        });
      });
    }
    return res.sendStatus(401);
  } catch {
    return res.sendStatus(500);
  }
});

app.post("/api/site/logout", (req, res) => {
  req.session.destroy(() => res.sendStatus(204));
});

app.get("/api/site/session", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.session?.siteAuthed === true) {
    return res.status(200).json({ authenticated: true });
  }
  return res.status(401).json({ authenticated: false });
});

// Formate une date au format francais (avec ou sans heure)
function fmtFR(dt, { withTime = true } = {}) {
  if (!dt) return "";
  const raw = String(dt);
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) {
    return withTime ? raw.replace('T',' ').replace('Z','') : raw.split('T')[0];
  }
  if (withTime) {
    return d.toLocaleString('fr-FR', {
      timeZone: 'Europe/Paris',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).replace(',', '');
  } else {
    return d.toLocaleDateString('fr-FR', {
      timeZone: 'Europe/Paris',
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
  }
}

// Base publique du site (utilisee dans les liens emails)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

// Email du responsable site pour les envois de mails
const SITE_RESP_EMAIL = (process.env.MAIL_CG || "").trim();

// Map magasin -> email responsable (lu depuis env JSON)
let RESP_SERVICE_BY_MAGASIN = {};
try {
  const raw = process.env.RESP_SERVICE_BY_MAGASIN_JSON;
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      RESP_SERVICE_BY_MAGASIN = parsed;
    }
  }
} catch {
  RESP_SERVICE_BY_MAGASIN = {};
}

// Retourne l'email responsable du service pour un magasin
function respServiceEmailFor(magasin) {
  const m = String(magasin || '').trim().toUpperCase();
  return (RESP_SERVICE_BY_MAGASIN[m] || '').trim();
}

// ajouter un vrai nom de responsable de site si besoin
function siteRespNameFor(_magasin) {
  return "";
}

// Montage des routes metiers
app.use("/atelier", atelierRouter);
app.use("/suivi-dossier", suiviDossier);
app.use("/presence", presences);
app.use("/api/kilometrage", kilometrageRouter);
app.use("/api/garantie", garantieRouter);

// Liste des magasins autorises pour export presences
const MAGASINS_EXPORT = ["ANNEMASSE","BOURGOIN","CHASSE SUR RHONE","CHASSIEU","GLEIZE","LA MOTTE SERVOLEX","MIRIBEL","PAVI","RENAGE","RIVES","SEYNOD","ST EGREVE","ST-JEAN-BONNEFONDS"];

// Helpers dates pour exports presences
const pad2 = n => String(n).padStart(2,'0');
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const daysOfMonth = (ym) => { const [y,m] = ym.split('-').map(Number); const out=[]; for(let i=1;i<=new Date(y,m,0).getDate();i++) out.push(new Date(y,m-1,i)); return out; };
const dowLetter = d => ["D","L","M","M","J","V","S"][d.getDay()];

// Recupere le JSON des presences pour un mois/magasin
async function fetchMonthStoreJSON(req, ym, magasin){
  const base = `${req.protocol}://${req.get('host')}`;
  const url  = `${base}/presence/month-store?yyyymm=${encodeURIComponent(ym)}&magasin=${encodeURIComponent(magasin)}`;
  const headers = {};
  const tok = req.get('X-Admin-Token');
  if (tok) headers['X-Admin-Token'] = tok;
  const { data } = await axios.get(url, { headers, timeout: 30000 });
  return data || {};
}

// Export Excel des presences du mois
app.get('/presence/export-month', requirePresencesAdminToken, async (req, res) => {
  try {
    const ym = String(req.query.yyyymm || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: 'Paramètre yyyymm invalide' });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Présences DSG';
    wb.created = new Date();

    const daysOfMonth = (ym) => { const [y,m]=ym.split('-').map(Number); const out=[]; for(let i=1;i<=new Date(y,m,0).getDate();i++) out.push(new Date(y,m-1,i)); return out; };
    const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const dowLetter = d => ["D","L","M","M","J","V","S"][d.getDay()];
    const days = daysOfMonth(ym);
    const isWE = d => d.getDay() === 0 || d.getDay() === 6;

    const C = {
      BLACK:'FF000000', WHITE:'FFFFFFFF',
      P:'FFE8F5EC', CP:'FFAE6FC9', R:'FF97F7D6', AB:'FFFECACA', AM:'FFDE5D5F', F:'FF5DDEC6',
      PSITE:'FFEBB926',
      EMPTY:'FFFFFFFF', NP:'FF000000'
    };
    const codeFill = (val) => {
      const v = String(val||'').trim().toUpperCase();
      if (!v) return { fgColor:{ argb:C.EMPTY } };
      if (C[v]) return { fgColor:{ argb:C[v] } };
      if (/^P\d+$/.test(v)) return { fgColor:{ argb:C.PSITE } };
      return { fgColor:{ argb:C.EMPTY } };
    };

    const thHeader = {
      font:{ bold:true, color:{ argb:C.BLACK } },
      alignment:{ horizontal:'center', vertical:'middle' },
      border:{ top:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'}, bottom:{style:'thin'} }
    };
    const tdStyle = {
      alignment:{ horizontal:'center', vertical:'middle' },
      border:{ top:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'}, bottom:{style:'thin'} }
    };

    const fetchMonthStoreJSON = async (req, ym, magasin) => {
      const base = `${req.protocol}://${req.get('host')}`;
      const url = `${base}/presence/month-store?yyyymm=${encodeURIComponent(ym)}&magasin=${encodeURIComponent(magasin)}`;
      const headers = {}; const tok = req.get('X-Admin-Token'); if (tok) headers['X-Admin-Token']=tok;
      const { data } = await axios.get(url, { headers, timeout: 30000 });
      return data || {};
    };

    const MAGASINS_EXPORT = [
      "ANNEMASSE","BOURGOIN","CHASSE SUR RHONE","CHASSIEU","GLEIZE",
      "LA MOTTE SERVOLEX","MIRIBEL","PAVI","RENAGE","RIVES",
      "SEYNOD","ST EGREVE","ST-JEAN-BONNEFONDS"
    ];

    const norm = s => String(s||"").trim().replace(/\s+/g," ").toUpperCase();

    const labelsFromMonthFile = (file) => {
      const byNorm = new Map();
      Object.values(file || {}).forEach(rec=>{
        (rec?.data?.rows || []).forEach(r=>{
          const raw = String(r.label || "").trim();
          if (!raw) return;
          const k = norm(raw);
          if (!byNorm.has(k)) byNorm.set(k, raw.toUpperCase());
        });
      });
      return [...byNorm.values()];
    };

    const buildNames = (arr, file, excludeSet = new Set()) => {
      const listFromArray = (items) => items
        .map(p => {
          if (typeof p === 'string') return p.trim();
          const nom = (p?.nom ?? '').toString().toUpperCase();
          const prenom = (p?.prenom ?? '').toString();
          const s = `${nom} ${prenom}`.trim();
          return s || (p?.label||'').toString().trim();
        })
        .filter(Boolean);

      let names = Array.isArray(arr) ? listFromArray(arr) : [];
      if (!names.length && file) {
        const set = new Set();
        Object.values(file).forEach(d => {
          const rows = (d?.data?.rows)||[];
          rows.forEach(r => { const lbl=String(r.label||'').trim(); if (lbl) set.add(lbl); });
        });
        names = Array.from(set);
      }
      const seen = new Set();
      return names.filter(n => {
        const k = n.toUpperCase();
        if (excludeSet.has(k) || seen.has(k)) return false; seen.add(k); return true;
      });
    };

    const collectSlots = (labels, file) => {
      const set = new Set(); const order=[];
      labels.forEach(lbl=>{
        const key = String(lbl).trim().toUpperCase();
        Object.values(file).forEach(day=>{
          const rows = (day?.data?.rows)||[];
          const found = rows.find(r => String(r.label||'').trim().toUpperCase() === key);
          if (found) Object.keys(found.values||{}).forEach(s => { if(!set.has(s)){ set.add(s); order.push(s); } });
        });
      });
      return order.length ? order : ['Matin','A. Midi'];
    };

    for (const mag of MAGASINS_EXPORT) {
      const { file = {}, personnel = { employes:[], interims:[], livreurs:{} } } =
        await fetchMonthStoreJSON(req, ym, mag);

      const labelsEmp = buildNames(personnel.employes, file);
      const setEmp = new Set(labelsEmp.map(s => s.toUpperCase()));

      const labelsInt = buildNames(personnel.interims, file, setEmp);
      const setEmpInt = new Set([...setEmp, ...labelsInt.map(s => s.toUpperCase())]);

      const knownNow = new Set([
        ...Array.from(setEmpInt.values()),
        ...Object.keys(personnel.livreurs||{}).map(norm)
      ]);
      const histAll = labelsFromMonthFile(file);
      const labelsOld = histAll.filter(lbl => !knownNow.has(norm(lbl)));

      const slotsEmp = collectSlots(labelsEmp, file);
      const slotsInt = collectSlots(labelsInt, file);
      const slotsOld = collectSlots(labelsOld, file);

      const ws = wb.addWorksheet(mag.substring(0,31), { properties:{ defaultColWidth: 12 } });

      ws.getColumn(1).hidden = false;
      ws.getColumn(1).width = 30;

      const writeSection = (title, labels, slots) => {
        if (!labels.length) return;

        ws.addRow([title]).font = { bold:true };
        ws.addRow([]);

        const h1=['Nom / Ligne'], h2=[''], h3=[''];
        days.forEach(d => { h1.push(...Array(slots.length).fill(dowLetter(d))); h2.push(...Array(slots.length).fill(d.getDate())); h3.push(...slots); });
        [ws.addRow(h1), ws.addRow(h2), ws.addRow(h3)].forEach(r => r.eachCell(c => Object.assign(c,{ style: thHeader })));

        labels.forEach(lbl=>{
          const rowVals=[lbl];
          days.forEach(d=>{
            const rec = file[ymd(d)];
            let values={};
            if (rec?.data?.rows){
              const found = rec.data.rows.find(r => String(r.label||'').trim().toUpperCase() === String(lbl).trim().toUpperCase());
              values = found?.values || {};
            }
            slots.forEach(s => rowVals.push(String(values[s]||'').trim().toUpperCase()));
          });

          const rr = ws.addRow(rowVals);

          const c1 = rr.getCell(1);
          c1.alignment = { horizontal:'left', vertical:'middle' };
          c1.font = { bold:true, color:{ argb:C.BLACK } };
          c1.border = tdStyle.border;

          rr.eachCell((c, idx) => {
            if (idx === 1) return;
            c.alignment = tdStyle.alignment;
            c.border = tdStyle.border;

            const dayIdx = Math.floor((idx - 2) / slots.length);
            const d = days[dayIdx];

            if (d && isWE(d)) {
              c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:C.BLACK } };
              c.font = { color:{ argb:C.WHITE }, bold:true };
            } else {
              const v = String(c.value||'').trim().toUpperCase();
              const fill = codeFill(v);
              c.fill = { type:'pattern', pattern:'solid', ...fill };
              c.font = { color:{ argb:C.BLACK } };
            }
          });
        });

        ws.addRow([]);
      };

      writeSection('EMPLOYÉS', labelsEmp, slotsEmp);
      writeSection('INTÉRIM',  labelsInt, slotsInt);
      writeSection('ANCIENNE TRAME', labelsOld, slotsOld);

      ws.getColumn(1).hidden = false;
      if (!ws.getColumn(1).width || ws.getColumn(1).width < 20) ws.getColumn(1).width = 30;
    }

    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Presences_${ym}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('export-month failed', err?.message || err);
    res.status(500).json({ error: 'Export impossible' });
  }
});

const FTP_ROOT_BASE = (process.env.FTP_BACKUP_FOLDER || "/").replace(/\/$/, "");
const PRES_ROOT     = `${FTP_ROOT_BASE}/presences`;
const ADJUST_LOG    = `${PRES_ROOT}/adjust_conges.jsonl`;

async function appendJSONL(client, remotePath, obj){
  const tmp = tmpFile("adj_"+Date.now()+".jsonl");
  try{
    try { await client.downloadTo(tmp, remotePath); } catch {}
    const dir = path.posix.dirname(remotePath);
    await client.ensureDir(dir);
    fs.appendFileSync(tmp, JSON.stringify(obj) + "\n", "utf8");
    await client.uploadFrom(tmp, remotePath);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

app.post("/presence/adjust-conges", requirePresencesAdminToken, async (req, res) => {
  try{
    const { magasin, date, entries, adjustments } = req.body || {};
    const list = Array.isArray(entries) ? entries : (Array.isArray(adjustments) ? adjustments : null);
    if (!magasin || !Array.isArray(list)) {
      return res.status(400).json({ ok:false, error:"bad_request" });
    }

    const stamp = new Date().toISOString();
    const payload = { magasin, date: date || stamp.slice(0,10), entries: list, stamp, source:"front" };

    try{
      const client = await ftpClient();
      await appendJSONL(client, ADJUST_LOG, payload);
      try{ client.close(); }catch{}
    }catch(e){
      console.warn("[adjust-conges] persistence skipped:", e?.message||e);
    }

    const GS_URL = process.env.CP_APPS_SCRIPT_URL || process.env.APPS_SCRIPT_URL || undefined;
    const SUPPORTS_ADJUST = String(process.env.CP_GS_SUPPORTS_ADJUST || "0") === "1";

    if (GS_URL) {
      for (const e of list) {
        const delta = Number(e.delta || 0);
        if (!delta || !e) continue;

        const full = String(e.fullName || "").trim();
        const nom = (e.nom || (full.split(/\s+/)[0] || "")).trim();
        const prenom = (e.prenom || (full.split(/\s+/).slice(1).join(" ") || "")).trim();

        try {
          if (SUPPORTS_ADJUST) {
            await fetch(`${GS_URL}?action=adjustcp`, {
              method:"POST",
              headers: { "Content-Type":"application/json" },
              body: JSON.stringify({ magasin, nom, prenom, delta })
            });
          } else if (delta < 0) {
            await fetch(`${GS_URL}?action=deccp`, {
              method:"POST",
              headers: { "Content-Type":"application/json" },
              body: JSON.stringify({ magasin, nom, prenom, nbJours: Math.abs(delta) })
            });
          }
        } catch(err) {
          console.warn("[adjust-conges] GS relay failed for", nom, prenom, delta, err?.message||err);
        }
      }
    }

    return res.json({ ok:true });
  }catch(e){
    console.error("[adjust-conges]", e);
    return res.status(200).json({ ok:true, note:"no_persist" });
  }
});

app.use("/presences", express.static(path.join(__dirname, "presences")));
app.use("/public", express.static(path.join(process.cwd(), "public")));
app.use("/api/ramasse", ramasseRouter);

app.use(adminEditorRouter());
app.get("/ramasse", (req, res) => res.redirect("/public/ramasse.html"));

app.use((req, res, next) => {
  const url = (req.originalUrl || req.url || "");
  const urlLower = url.toLowerCase();
  const method = req.method;

  res.on("finish", async () => {
    try {
      const success = res.statusCode >= 200 && res.statusCode < 400;
      if (!success || method !== "POST") return;

      if (urlLower.startsWith("/formulaire-piecepl"))      await stats.recordSubmission("piecepl");
      else if (urlLower.startsWith("/formulaire-piece"))   await stats.recordSubmission("piece");
      else if (urlLower.startsWith("/formulaire-pneu"))    await stats.recordSubmission("pneu");
    } catch (e) {
      console.warn("[COMPTEUR] post-hook erreur:", e?.message || e);
    }
  });

  next();
});
const APPS_SCRIPT_URL_LUB   = process.env.TELEVENTE_APPS_SCRIPT_URL_LUB   || "";
const APPS_SCRIPT_URL_BOSCH = process.env.TELEVENTE_APPS_SCRIPT_URL_BOSCH || "";

function makeTeleventeProxy(appsScriptUrl) {
  return async (req, res) => {
    if (!appsScriptUrl) {
      return res.status(500).json({
        error: "not_configured",
        message: "Apps Script URL is not set for this televente proxy"
      });
    }

    const tryOnce = async () =>
      axios.get(appsScriptUrl, {
        timeout: 12000,
        params: req.query,
        headers: { "User-Agent": "televente-proxy/1.0" },
      });

    try {
      let r;
      try {
        r = await tryOnce();
      } catch {
        await new Promise(t => setTimeout(t, 400));
        r = await tryOnce();
      }
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json(r.data);
    } catch (e) {
      res.status(502).json({
        error: "proxy_failed",
        message: e?.message || "Bad gateway",
      });
    }
  };
}

app.get("/api/sheets/televente-lub", requireBackofficeAuth, makeTeleventeProxy(APPS_SCRIPT_URL_LUB));
app.get("/api/sheets/televente-bosch", requireBackofficeAuth, makeTeleventeProxy(APPS_SCRIPT_URL_BOSCH));


app.get("/stats/counters", async (_req, res) => {
  try { const data = await stats.getCounters(); res.json({ ok: true, data }); }
  catch (e) { console.error("Erreur /stats/counters:", e); res.status(500).json({ ok: false, error: "Erreur de lecture des compteurs" }); }
});
app.get("/admin/compteurs", requireBackofficeAuth, async (_req, res) => {
  try { const data = await stats.getCounters(); res.json(data); }
  catch (e) { console.error("Erreur /admin/compteurs:", e); res.status(500).json({ error: "Erreur de lecture des compteurs" }); }
});
app.get("/compteur", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "compteur.html"));
});
app.post("/api/visits/increment", async (_req, res) => {
  try {
    await visits.recordVisit();
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.warn("[VISITS] increment failed:", e?.message || e);
    return res.status(500).json({ ok: false, error: "increment_failed" });
  }
});

app.get("/api/visits/stats", async (_req, res) => {
  try {
    const data = await visits.getVisits();
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, data });
  } catch (e) {
    console.warn("[VISITS] stats failed:", e?.message || e);
    return res.status(500).json({ ok: false, error: "stats_failed" });
  }
});

console.log("[BOOT] public/conges ?", fs.existsSync(path.join(__dirname, "public", "conges")));
console.log("[BOOT] public/conges/index.html ?", fs.existsSync(path.join(__dirname, "public", "conges", "index.html")));
app.get("/conges/ping", (_req, res) => res.status(200).send("pong"));
app.get("/conges", (_req, res) => { res.sendFile(path.join(__dirname, "public", "conges", "index.html")); });

function esc(str = "") {
  return String(str)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function fmtDateFR(dateStr = "") {
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : dateStr;
}

const LEAVES_FILE   = `${PRES_ROOT}/leaves.json`;
const UNITS_DIR     = `${PRES_ROOT}/units`;

const PDF_DIR_PREFS = [
  `${FTP_ROOT_BASE}/presence/leave`,
  `${PRES_ROOT}/leave`,
];

const FTP_DEBUG = String(process.env.PRESENCES_FTP_DEBUG||"0")==="1";
const FTP_RETRYABLE = /ECONNRESET|Client is closed|ETIMEDOUT|ENOTCONN|EPIPE|426|425/i;

function tlsOptions(){
  const rejectUnauthorized = String(process.env.FTP_TLS_REJECT_UNAUTH||"1")==="1";
  const servername = process.env.FTP_HOST || undefined;
  return { rejectUnauthorized, servername };
}

async function ftpClient(){
  const client = new ftp.Client(45_000);
  if (FTP_DEBUG) client.ftp.verbose = true;

  client.prepareTransfer = ftp.enterPassiveModeIPv4;

  await client.access({
    host: process.env.FTP_HOST,
    user: process.env.FTP_USER,
    password: process.env.FTP_PASS || process.env.FTP_PASSWORD,
    port: process.env.FTP_PORT ? Number(process.env.FTP_PORT) : 21,
    secure: String(process.env.FTP_SECURE||"false")==="true",
    secureOptions: tlsOptions()
  });

  try {
    client.ftp.socket?.setKeepAlive?.(true, 10_000);
    client.ftp.timeout = 45_000;
  } catch {}

  return client;
}


function normFtpPath_(p){
  // Normalise en chemin POSIX compatible FTP
  let s = String(p || "").trim().replace(/\\+/g, "/");
  // retire les doubles slash (sauf éventuellement au début)
  s = s.replace(/\/+/g, "/");
  // retire trailing slash
  s = s.replace(/\/+$/,"");
  return s;
}

async function ensureDirSafe_(client, dir){
  const d = normFtpPath_(dir);
  try{
    await client.ensureDir(d);
    return d;
  }catch(e){
    // Certains serveurs FTP refusent les chemins absolus "/..."
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes("550") && d.startsWith("/")){
      const d2 = d.replace(/^\/+/, "");
      await client.ensureDir(d2);
      return d2;
    }
    throw e;
  }
}

async function uploadFromSafe_(client, localPath, remotePath){
  const rp = normFtpPath_(remotePath);
  try{
    await client.uploadFrom(localPath, rp);
    return rp;
  }catch(e){
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes("550") && rp.startsWith("/")){
      const rp2 = rp.replace(/^\/+/, "");
      await client.uploadFrom(localPath, rp2);
      return rp2;
    }
    throw e;
  }
}


function tmpFile(name){ return path.join(os.tmpdir(), name); }

async function dlJSON(client, remote){
  const out = tmpFile("lv_"+Date.now()+".json");
  for (let attempt=1; attempt<=4; attempt++){
    try{
      await client.downloadTo(out, remote);
      const txt = fs.readFileSync(out, "utf8");
      try{ fs.unlinkSync(out); }catch{}
      return JSON.parse(txt);
    }catch(e){
      if (String(e?.code) === "550") { try{ fs.unlinkSync(out); }catch{}; return null; }
      const msg = String(e?.message||"") + " " + String(e?.code||"");
      if (attempt === 4 || !FTP_RETRYABLE.test(msg)) {
        try{ fs.unlinkSync(out); }catch{}; return null;
      }
      try{ client.close(); }catch{}
      client = await ftpClient();
      await new Promise(r => setTimeout(r, 250*attempt));
    }
  }
  return null;
}

async function upJSON(client, remote, obj){
  const out = tmpFile("lv_up_"+Date.now()+".json");
  fs.writeFileSync(out, JSON.stringify(obj));
  const dir = path.posix.dirname(remote);

  for (let attempt=1; attempt<=4; attempt++){
    try{
      await client.ensureDir(dir);
      await client.uploadFrom(out, remote);
      try{ fs.unlinkSync(out); }catch{}
      return;
    }catch(e){
      const msg = String(e?.message||"") + " " + String(e?.code||"");
      if (attempt === 4 || !FTP_RETRYABLE.test(msg)) {
        try{ fs.unlinkSync(out); }catch{}
        console.error("[FTP upJSON] fail", { dir, remote, code: e?.code, msg: e?.message });
        throw e;
      }
      try{ client.close(); }catch{}
      client = await ftpClient();
      await new Promise(r => setTimeout(r, 300*attempt));
    }
  }
}

async function upText(client, remote, buf){
  const dir = path.posix.dirname(remote);
  const out = tmpFile("lv_file_"+Date.now());
  fs.writeFileSync(out, buf);

  for (let attempt=1; attempt<=4; attempt++){
    try{
      await client.ensureDir(dir);
      await client.uploadFrom(out, remote);
      try{ fs.unlinkSync(out); }catch{}
      return;
    }catch(e){
      const msg = String(e?.message||"") + " " + String(e?.code||"");
      if (attempt === 4 || !FTP_RETRYABLE.test(msg)) {
        try{ fs.unlinkSync(out); }catch{}
        throw e;
      }
      try{ client.close(); }catch{}
      client = await ftpClient();
      await new Promise(r => setTimeout(r, 300*attempt));
    }
  }
}

async function uploadPdfToPreferredDir(client, localTmpPath, destName){
  let lastErr;
  for (const d of PDF_DIR_PREFS){
    try{
      await client.ensureDir(d);
      const remote = `${d}/${destName}`;
      await client.uploadFrom(localTmpPath, remote);
      if (FTP_DEBUG) console.log("[FTP] PDF uploaded:", remote);
      return remote;
    }catch(e){
      lastErr = e;
      console.warn("[FTP] PDF upload failed in", d, "-", e?.code, e?.message);
    }
  }
  throw lastErr;
}

async function appendLeave(payload) {

  const leaveId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let lastErr;

  for (let i = 0; i < 3; i++) {
    let client;
    try {
      client = await ftpClient();
      await client.ensureDir(PRES_ROOT);
      await client.ensureDir(UNITS_DIR);

      const arr = (await dlJSON(client, LEAVES_FILE)) || [];

      let item = arr.find(x => x.id === leaveId);
      if (!item) {
        item = {
          id: leaveId,
          createdAt: new Date().toISOString(),
          status: "pending",
          statusFr: "en attente",
          ...payload,
        };
        arr.push(item);
        await upJSON(client, LEAVES_FILE, arr);

        const safe = s => String(s || "")
          .normalize("NFKD").replace(/[^\w.-]+/g, "_").slice(0, 64);
        const base = `${item.createdAt.slice(0,10)}_${safe(item.magasin)}_${safe(item.nom)}_${safe(item.prenom)}_${item.id}.json`;
        await upText(client, `${UNITS_DIR}/${base}`, JSON.stringify(item, null, 2));
      }

      try { client.close(); } catch {}
      return item.id;
    } catch (e) {
      lastErr = e;
      try { client?.close(); } catch {}
      await new Promise(t => setTimeout(t, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

async function patchLeave(id, patch){
  let client;
  try{
    client = await ftpClient();
    const arr = (await dlJSON(client, LEAVES_FILE)) || [];
    const i = arr.findIndex(x => x.id === id);
    if (i >= 0) {
      arr[i] = { ...arr[i], ...patch };
      await upJSON(client, LEAVES_FILE, arr);

      const safe = (s) => String(s || "").normalize("NFKD").replace(/[^\w.-]+/g, "_").slice(0, 64);
      const base = `${arr[i].createdAt.slice(0,10)}_${safe(arr[i].magasin)}_${safe(arr[i].nom)}_${safe(arr[i].prenom)}_${arr[i].id}.json`;
      const unit = `${UNITS_DIR}/${base}`;
      await upText(client, unit, JSON.stringify(arr[i], null, 2));
      return arr[i];
    }
    return null;
  } finally { try{ client?.close(); }catch{} }
}

async function makeLeavePdf({ logoUrl, magasin, nomPrenom, service, nbJours, du, au, signatureData }) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  function drawCrossInBox(doc, x, y, size) {
    const pad = Math.max(2, Math.round(size * 0.2));
    doc.save();
    doc.lineWidth(1.5);
    doc.moveTo(x + pad, y + pad).lineTo(x + size - pad, y + size - pad).stroke();
    doc.moveTo(x + size - pad, y + pad).lineTo(x + pad, y + size - pad).stroke();
    doc.restore();
  }

  const pageLeft = 50;
  const pageRight = 545;
  const logoX = pageLeft;
  const logoY = 40;
  const logoW = 120;

  const titleX = logoX + logoW + 20;
  const titleWidth = pageRight - titleX;

  try {
    const resp = await fetch(logoUrl);
    const buf = Buffer.from(await resp.arrayBuffer());
    doc.image(buf, logoX, logoY, { width: logoW });
  } catch (e) {
    console.warn("[CONGES][PDF] Logo non chargé:", e.message);
  }

  const titleStr = "DEMANDE DE JOURS DE CONGÉS";
  doc.fontSize(18).font("Helvetica-Bold").text(titleStr, titleX, logoY + 45, { width: titleWidth, align: "left" });

  let y = 180;

  const bodySize = 13;
  const labelGap = 32;
  const rowGap = 38;
  const afterServicesGap = 38;
  const afterDemandGap = 26;
  const afterPeriodGap = 36;

  doc.fontSize(bodySize).font("Helvetica-Bold").text("SITE :", pageLeft, y);
  doc.font("Helvetica").text(magasin || "", pageLeft + 55, y);
  y += labelGap;

  const parts = String(nomPrenom || "").trim().split(/\s+/);
  const _nom = parts[0] || "";
  const _prenom = parts.slice(1).join(" ");

  doc.font("Helvetica").fontSize(bodySize);
  doc.text("NOM :", pageLeft, y);
  doc.text(_nom, pageLeft + 55, y, { width: 250 });
  y += rowGap;

  doc.text("PRENOM :", pageLeft, y);
  doc.text(_prenom, pageLeft + 85, y, { width: 300 });
  y += rowGap;

  const services = [
    "Magasin V.L", "Magasin P.L", "Industrie",
    "Atelier V.L", "Atelier P.L", "Rectification",
    "Administratif", "Commercial", "Matériel"
  ];
  const cols = 3, colW = (pageRight - pageLeft) / cols, box = 11, lh = 28;

  doc.fontSize(12);
  services.forEach((s, i) => {
    const r  = Math.floor(i / cols), c = i % cols;
    const x  = pageLeft + c * colW;
    const yy = y + r * lh;
    doc.rect(x, yy, box, box).stroke();
    if (service && s.toLowerCase() === String(service).toLowerCase()) {
      drawCrossInBox(doc, x, yy, box);
    }
    doc.font("Helvetica").text(s, x + box + 6, yy - 2);
  });

  y += Math.ceil(services.length / cols) * lh + afterServicesGap;

  doc.fontSize(bodySize).text(`Demande de pouvoir bénéficier de ${nbJours} jour(s) de congés`, pageLeft, y);
  y += afterDemandGap;

  doc.text(`du ${du}`, pageLeft, y);
  y += 20;
  doc.text(`au ${au} inclus.`, pageLeft, y);
  y += afterPeriodGap;

  doc.text("Signature de l’employé,", 370, y);
  if (signatureData && /^data:image\/png;base64,/.test(signatureData)) {
    try {
      const b64 = signatureData.split(",")[1];
      const sigBuf = Buffer.from(b64, "base64");
      const sigY = y + 14;
      doc.image(sigBuf, 370, sigY, { width: 150 });
      y = Math.max(y + 90, sigY + 90);
    } catch { y += 70; }
  } else { y += 70; }

  const colLeft = 50;
  const colRight = 330;
  doc.font("Helvetica-Bold").text("RESPONSABLE DU SERVICE :", colLeft, y);
  doc.text("RESPONSABLE DE SITE :", colRight, y);
  y += 22; doc.font("Helvetica").fontSize(bodySize);
  doc.text("NOM :", colLeft, y);
  doc.text("NOM :", colRight, y);
  y += 22;
  doc.text("SIGNATURE :", colLeft, y);
  doc.text("SIGNATURE :", colRight, y);

  doc.end();
  return done;
}

// Coordonnees d'incrustation de signature dans le PDF conges
const SIGN_COORDS = {
  resp_service: { page: 0, x: 120, y: 130, w: 220, h: 70 },
  resp_site:    { page: 0, x: 390, y: 130, w: 220, h: 70 },
};
const NAME_COORDS = {
  resp_service: { page: 0, x: 120, y: 210, size: 12 },
  resp_site:    { page: 0, x: 390, y: 210, size: 12 },
};

// ---- DEMANDE DE CONGES (generation PDF + envoi mail) ----
app.post("/conges/api", async (req, res) => {
  try {
    const { magasin, nomPrenom, nom, prenom, service, nbJours, dateDu, dateAu, email, signatureData } = req.body || {};
    const errors = [];

    if (!magasin) errors.push("magasin");
    if (!service) errors.push("service");
    if (!email)   errors.push("email");

    const n = Number(nbJours);
    if (!Number.isFinite(n) || n <= 0) errors.push("nbJours");

    const d1 = new Date(dateDu), d2 = new Date(dateAu);
    if (!dateDu || !dateAu || isNaN(d1) || isNaN(d2) || d2 < d1) errors.push("plageDates");

    const reMail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!reMail.test(String(email))) errors.push("email");

    if (!signatureData || String(signatureData).length < 2000 || !/^data:image\/png;base64,/.test(signatureData)) {
      errors.push("signature");
    }

    let _nom = String(nom || "").trim();
    let _prenom = String(prenom || "").trim();
    if (!_nom && !_prenom && nomPrenom) {
      const parts = String(nomPrenom).trim().split(/\s+/);
      _nom = parts.slice(-1)[0] || "";
      _prenom = parts.slice(0, -1).join(" ");
    }
    if (!_nom) errors.push("nom");
    if (!_prenom) errors.push("prenom");

    if (errors.length) return res.status(400).json({ ok:false, error:"invalid_fields", fields:errors });

    const leaveId = await appendLeave({
      magasin, nom:_nom, prenom:_prenom, service, nbJours:n, dateDu, dateAu, email
    });

    const duFR = fmtDateFR(dateDu), auFR = fmtDateFR(dateAu);
    const nomPrenomStr = `${_nom.toUpperCase()} ${_prenom}`;
    const pdfBuffer = await makeLeavePdf({
      logoUrl: "https://raw.githubusercontent.com/docudurand/docudurpho/main/logodurand.png",
      magasin,
      nomPrenom: nomPrenomStr,
      service,
      nbJours: n,
      du: duFR,
      au: auFR,
      signatureData,
    });

    const clientUp = await ftpClient();
    const tmp = tmpFile("leave_"+leaveId+".pdf");
    fs.writeFileSync(tmp, pdfBuffer);
    let remotePdfPath;
    try {
      remotePdfPath = await uploadPdfToPreferredDir(clientUp, tmp, `${leaveId}.pdf`);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
      try { clientUp.close(); } catch {}
    }

    const tokenService = crypto.randomBytes(16).toString("hex");
    const tokenSite    = crypto.randomBytes(16).toString("hex");
    await patchLeave(leaveId, {
      pdfPath: remotePdfPath,
      tokens: { resp_service: tokenService, resp_site: tokenSite }
    });

    if (!transporter) {
  console.warn("[CONGES] smtp_not_configured");
  return res.status(500).json({ ok:false, error:"smtp_not_configured" });
}

const linkService = `${PUBLIC_BASE_URL}/conges/sign/${leaveId}?role=resp_service&token=${tokenService}`;
const linkSite    = `${PUBLIC_BASE_URL}/conges/sign/${leaveId}?role=resp_site&token=${tokenSite}`;

const subject = `Demande - ${nomPrenomStr}`;
const html = `
  <h2>Demande de Jours de Congés</h2>
  <p><b>Magasin :</b> ${esc(magasin)}</p>
  <p><b>Nom :</b> ${esc(_nom)}</p>
  <p><b>Prénom :</b> ${esc(_prenom)}</p>
  <p><b>Service :</b> ${esc(service)}</p>
  <p><b>Demande :</b> ${n} jour(s) de congés</p>
  <p><b>Période :</b> du ${esc(duFR)} au ${esc(auFR)}</p>
  <p><b>Email du demandeur :</b> ${esc(email)}</p>
  <hr/>
  <p><b>Validation :</b></p>
  <p>
    <a href="${esc(linkService)}">Signer (Responsable de service)</a>
    &nbsp;|&nbsp;
    <a href="${esc(linkSite)}">Signer (Responsable de site)</a>
  </p>
`;

const toList = [ SITE_RESP_EMAIL, respServiceEmailFor(magasin) ].filter(Boolean);
const toRecipients = toList.length ? toList.join(",") : email;


await transporter.sendMail({
  to: toRecipients,
  from: `Demande jours de congés <${fromEmail}>`,
  replyTo: email,
  subject,
  html,
  attachments: [{
    filename: `Demande-conges-${nomPrenomStr.replace(/[^\w.-]+/g, "_")}.pdf`,
    content: pdfBuffer,
    contentType: "application/pdf"
  }],
});

    res.json({ ok:true, id: leaveId });
  } catch (e) {
    console.error("[/conges/api] Erreur:", e);
    res.status(500).json({ ok:false, error:"send_failed" });
  }
});

// Page de signature en ligne (canvas + POST)
app.get("/conges/sign/:id", async (req, res) => {
  const { id } = req.params;
  const role = String(req.query.role||"").trim();
  const token = String(req.query.token||"").trim();
  if (!["resp_service","resp_site"].includes(role) || !token) {
    return res.status(400).send("Lien invalide.");
  }

  const prefillName = "";

  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(`
<!doctype html><meta charset="utf-8"/>
<title>Signature – Validation congés</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;color:#111}
.wrap{max-width:560px;margin:0 auto}
canvas{border:1px solid #ddd;border-radius:8px;width:100%;height:220px;display:block;background:#fff}
button{padding:10px 14px;border-radius:10px;border:0;background:#1d4ed8;color:#fff;font-weight:700;cursor:pointer}
label{display:block;margin:12px 0 6px}
input{width:100%;padding:10px;border:1px solid #ddd;border-radius:8px}
.note{color:#666;margin-top:8px}
</style>
<div class="wrap">
  <h1>Signature – ${role === "resp_service" ? "Responsable de service" : "Responsable de site"}</h1>
  <p class="note">Signez pour valider la demande.</p>
  <canvas id="pad"></canvas>
  <label>Nom / Qualité</label>
  <input id="fullName" placeholder="Ex: Dupont – Resp. service"/>
  <div style="display:flex;gap:10px;margin-top:10px">
    <button id="clear" type="button" style="background:#6b7280">Effacer</button>
    <button id="ok" type="button">Valider ma signature</button>
  </div>
</div>
<script>
const role=${JSON.stringify(role)}, token=${JSON.stringify(token)}, id=${JSON.stringify(id)};
const prefillSiteName=${JSON.stringify(prefillName)};
const c=document.getElementById('pad'), ctx=c.getContext('2d'); let draw=false, pts=[];
function size(){ const img=new Image(); img.onload=()=>{ c.width=c.clientWidth; c.height=220; ctx.fillStyle="#fff"; ctx.fillRect(0,0,c.width,c.height); ctx.drawImage(img,0,0,c.width,c.height); }
img.src=c.toDataURL(); }
window.addEventListener('resize', size); size();
if(role==="resp_site"){ document.getElementById('fullName').value=prefillSiteName; }
function P(e){const r=c.getBoundingClientRect();const t=e.touches&&e.touches[0];return {x:(t?t.clientX:e.clientX)-r.left,y:(t?t.clientY:e.clientY)-r.top};}
c.addEventListener('mousedown', e=>{draw=true;pts=[P(e)]});
c.addEventListener('mousemove', e=>{ if(!draw)return; const a=pts[pts.length-1], b=P(e); ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); pts.push(b); });
["mouseup","mouseleave"].forEach(ev=>c.addEventListener(ev,()=>draw=false));
c.addEventListener('touchstart', e=>{e.preventDefault(); draw=true; pts=[P(e)]},{passive:false});
c.addEventListener('touchmove', e=>{e.preventDefault(); if(!draw)return; const a=pts[pts.length-1], b=P(e); ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); pts.push(b); },{passive:false});
c.addEventListener('touchend', ()=>draw=false);
document.getElementById('clear').onclick=()=>{ ctx.fillStyle="#fff"; ctx.fillRect(0,0,c.width,c.height); pts=[]; };
document.getElementById('ok').onclick=async()=>{
  if(pts.length<2) return alert("Merci de signer.");
  const fullName = document.getElementById('fullName').value.trim();
  if(!fullName) return alert("Merci d'indiquer votre nom/qualité.");
  const imageBase64 = c.toDataURL("image/png");
  const r = await fetch("/conges/sign/"+id, {
    method:"POST", headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ role, token, imageBase64, fullName })
  });
  const j = await r.json().catch(()=>({}));
  if (j.ok) { alert("Signature enregistrée. Merci !"); location.href = "about:blank"; }
  else alert("Erreur: " + (j.error||""));
};
</script>`);
});

// Enregistre la signature et met a jour le PDF
app.post("/conges/sign/:id", async (req, res) => {
  const { id } = req.params;
  const { role, token, imageBase64, fullName } = req.body || {};
  if (!["resp_service","resp_site"].includes(String(role))) {
    return res.status(400).json({ ok:false, error:"role_invalid" });
  }
  if (!imageBase64?.startsWith("data:image/png;base64,")) {
    return res.status(400).json({ ok:false, error:"image_missing" });
  }
  let client;
  try{
    client = await ftpClient();
    const arr = (await dlJSON(client, LEAVES_FILE)) || [];
    const i = arr.findIndex(x => x.id === id);
    if (i < 0) return res.status(404).json({ ok:false, error:"leave_not_found" });
    const item = arr[i];

    const tokens = item.tokens || {};
    const expected = tokens[role];
    if (!expected || expected !== token) {
      return res.status(401).json({ ok:false, error:"token_invalid_or_used" });
    }

    let remotePdf = item.pdfPath;
    if (!remotePdf) {
      for (const d of PDF_DIR_PREFS) {
        const candidate = `${d}/${id}.pdf`;
        try {
          const tmpCheck = tmpFile("chk_"+id+".pdf");
          await client.downloadTo(tmpCheck, candidate);
          try { fs.unlinkSync(tmpCheck); } catch {}
          remotePdf = candidate;
          break;
        } catch {}
      }
      if (!remotePdf) return res.status(404).json({ ok:false, error:"pdf_not_found" });
    }

    const tmpPdf = tmpFile("pdf_"+id+".pdf");
    await client.downloadTo(tmpPdf, remotePdf);
    const pdfBytes = fs.readFileSync(tmpPdf);

    const pdfDoc = await PDFLib.load(pdfBytes, { updateMetadata:false });
    const pngBytes = Buffer.from(imageBase64.split(",")[1], "base64");
    const png = await pdfDoc.embedPng(pngBytes);

    const { page, x, y, w, h } = SIGN_COORDS[role];
    const pg = pdfDoc.getPage(page);
    const { width: iw, height: ih } = png.scale(1);
    const ratio = Math.min(w/iw, h/ih);
    const ww = iw*ratio, hh = ih*ratio;
    const xx = x + (w - ww)/2, yy = y + (h - hh)/2;
    pg.drawImage(png, { x: xx, y: yy, width: ww, height: hh });

    const namePos = NAME_COORDS[role];
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    let signerName = String(fullName || "").trim();

    pg.drawText(signerName, { x: namePos.x, y: namePos.y, size: namePos.size, font, color: rgb(0,0,0) });
    const auditTxt = `${dayjs().format("YYYY-MM-DD HH:mm")} • ${signerName} • ${role}`;
    pg.drawText(auditTxt, { x: 40, y: 30, size: 8, font, color: rgb(0.25,0.25,0.25) });

    const out = await pdfDoc.save();
    fs.writeFileSync(tmpPdf, out);
    await client.uploadFrom(tmpPdf, remotePdf);
    try{ fs.unlinkSync(tmpPdf); }catch{}

    const patch = { tokens: { ...tokens, [role]: null } };
    if (role === "resp_service") patch.signedService = { at: new Date().toISOString(), by: signerName };
    if (role === "resp_site")    patch.signedSite    = { at: new Date().toISOString(), by: signerName };

    arr[i] = { ...item, ...patch, pdfPath: remotePdf };

    await upJSON(client, LEAVES_FILE, arr);

    const safe = s => String(s||"").normalize("NFKD").replace(/[^\w.-]+/g,"_").slice(0,64);
    const base = `${arr[i].createdAt.slice(0,10)}_${safe(arr[i].magasin)}_${safe(arr[i].nom)}_${safe(arr[i].prenom)}_${arr[i].id}.json`;
    await upText(client, `${UNITS_DIR}/${base}`, JSON.stringify(arr[i], null, 2));

    const bothSigned = !!(arr[i].signedService && arr[i].signedSite);

if (bothSigned && !arr[i].finalMailSent) {
  try {
    if (!transporter) {
      console.warn("[CONGES] Mail final non envoyé (SMTP non configuré)");
    } else {
      const tmpFinal = tmpFile("final_" + id + ".pdf");
      await client.downloadTo(tmpFinal, remotePdf);

      const demanderEmail = arr[i].email || "";
      const recipients = [SITE_RESP_EMAIL, demanderEmail].filter(Boolean).join(",");

      await transporter.sendMail({
        to: recipients,
        from: `Validation congés <${fromEmail}>`,
        replyTo: demanderEmail || undefined,
        subject: `Acceptation — ${(arr[i].nom || "").toUpperCase()} ${arr[i].prenom || ""}`,
        html: `...`,
        attachments: [{ filename: `Demande-conges-${(arr[i].nom || "").toUpperCase()}_${arr[i].prenom || ""}.pdf`, path: tmpFinal }]
      });

      try { fs.unlinkSync(tmpFinal); } catch {}

      arr[i].finalMailSent = { at: new Date().toISOString(), to: recipients };
      await upJSON(client, LEAVES_FILE, arr);
      await upText(client, `${UNITS_DIR}/${base}`, JSON.stringify(arr[i], null, 2));
    }
  } catch (e) {
    console.warn("[CONGES] Envoi mail final (double signature) a échoué:", e?.message || e);
  }
}

    return res.json({ ok: true, accepted: bothSigned });
  } catch(e){
    console.error(e);
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  } finally {
    try { client?.close(); } catch {}
  }
});

app.get("/healthz", (_req, res) => res.sendStatus(200));
app.get("/healthz/details", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    status: "ok",
    uptimeSec: Math.floor(process.uptime()),
ts: new Date().toISOString(),
  });
});
app.get("/", (_req, res) => res.status(200).send("📝 Mes Formulaires – service opérationnel"));

// Routes des differents formulaires
app.use("/formtelevente", requireBackofficeAuth, formtelevente);
app.use("/formulaire-piece", formulairePiece);
app.use("/formulaire-piecepl", formulairePiecePL);
app.use("/formulaire-pneu", formulairePneu);

// Pret vehicule: pages statiques + API
const pretPublic = path.join(__dirname, "pretvehiculed", "public");
app.use("/pret", express.static(pretPublic, { extensions: ["html", "htm"], index: false }));
app.get("/pret/fiche", (_req, res) => res.sendFile(path.join(pretPublic, "fiche-pret.html")));
app.get("/pret/admin", (_req, res) => res.sendFile(path.join(pretPublic, "admin-parc.html")));
app.use("/pret/api", requireBackofficeAuth, loansRouter);

function parseEnvJSON(raw, fallback) {
  let s = String(raw ?? "").trim();
  if (!s) return fallback;

  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1);
  }
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function loadJsonFromFtpOrEnv(filename, envVarName, fallback) {
  try {
    const data = await ftpStorage.readJson(filename);
    if (data != null) return data;
  } catch (e) {
    console.warn("[FTP] lecture JSON failed:", filename, e?.message || e);
  }

  if (!envVarName) return fallback;
  const raw = process.env[envVarName];
  if (!raw) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(String(raw).trim().replace(/^['"]|['"]$/g, ""));
  } catch {
    throw new Error(`${envVarName} invalide`);
  }

  try {
    await ftpStorage.writeJson(filename, parsed, { backup: false });
  } catch (e) {
    console.warn("[FTP] bootstrap write failed:", filename, e?.message || e);
  }

  return parsed;
}

async function loadJsonFromFtpOrDefault(filename, defaultProvider) {
  try {
    const data = await ftpStorage.readJson(filename);
    if (data != null) return data;
  } catch (e) {
    console.warn("[FTP] lecture JSON failed:", filename, e?.message || e);
  }

  if (typeof defaultProvider !== "function") return null;
  try {
    const def = await defaultProvider();
    if (def != null) {
      try {
        await ftpStorage.writeJson(filename, def, { backup: false });
      } catch (e) {
        console.warn("[FTP] bootstrap write failed:", filename, e?.message || e);
      }
      return def;
    }
  } catch (e) {
    console.warn("[DEFAULT] provider failed:", filename, e?.message || e);
  }
  return null;
}

app.get("/api/pl/liens-garantie-retour", async (_req, res) => {
  try {
    const data = await loadJsonFromFtpOrEnv(
      "pl_liens_garantie_retour.json",
      "PL_LIENS_GARANTIE_RETOUR_JSON",
      []
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(data);
  } catch (e) {
    return res.status(500).json({ error: "PL_LIENS_GARANTIE_RETOUR_JSON invalide" });
  }
});

app.get("/api/vl/retour-garantie", async (_req, res) => {
  try {
    const data = await loadJsonFromFtpOrEnv(
      "vl_retour_garantie.json",
      "VL_RETOUR_GARANTIE_JSON",
      {}
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(data);
  } catch (e) {
    return res.status(500).json({ error: "VL_RETOUR_GARANTIE_JSON invalide" });
  }
});
app.get("/api/vl/liens-formulaire-garantie", async (_req, res) => {
  try {
    const data = await loadJsonFromFtpOrEnv(
      "vl_liens_formulaire_garantie.json",
      "VL_LIENS_FORMULAIRE_GARANTIE_JSON",
      []
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(data);
  } catch (e) {
    return res.status(500).json({ error: "VL_LIENS_FORMULAIRE_GARANTIE_JSON invalide" });
  }
});

app.get("/api/pl/fournisseur-pl", async (_req, res) => {
  try {
    const data = await loadJsonFromFtpOrDefault("fournisseur_pl.json", () => seedFournisseurPl());
    res.setHeader("Cache-Control", "no-store");
    return res.json(Array.isArray(data) ? data : []);
  } catch (e) {
    return res.status(500).json({ error: "fournisseur_pl_load_failed" });
  }
});

app.get("/api/vl/fournisseur-vl", async (_req, res) => {
  try {
    const data = await loadJsonFromFtpOrDefault("fournisseur_vl.json", () => seedFournisseurVl());
    res.setHeader("Cache-Control", "no-store");
    return res.json(data || {});
  } catch (e) {
    return res.status(500).json({ error: "fournisseur_vl_load_failed" });
  }
});

app.get("/api/util/site-identification-oe", async (_req, res) => {
  try {
    const data = await loadJsonFromFtpOrDefault("site_identification_oe.json", () => seedSiteIdentificationOe());
    res.setHeader("Cache-Control", "no-store");
    return res.json(Array.isArray(data) ? data : []);
  } catch (e) {
    return res.status(500).json({ error: "site_identification_oe_load_failed" });
  }
});
// Pages statiques PL / VL
app.use("/pl", express.static(path.join(__dirname, "pl"), {
  extensions: ["html", "htm"],
  index: false
}));

app.use("/vl", express.static(path.join(__dirname, "vl"), {
  extensions: ["html", "htm"],
  index: false
}));

// Assets generaux (images, css, etc.)
app.use("/assets", express.static(path.join(__dirname, "assets")));

// Fichiers statiques du dossier garantie (formulaires, PDFs)
app.use("/garantie", express.static(path.join(__dirname, "garantie"), {
  extensions: ["html", "htm"],
  index: false
}));

// Contacts fournisseurs (depuis env JSON)
app.get("/api/util/contacts-fournisseurs", async (_req, res) => {
  try {
    const data = await loadJsonFromFtpOrEnv(
      "contacts_fournisseurs.json",
      "CONTACTS_FOURNISSEURS_JSON",
      []
    );
    res.setHeader("Cache-Control", "no-store");
    return res.json(data);
  } catch (e) {
    return res.status(500).json({
      error: "CONTACTS_FOURNISSEURS_JSON invalid",
      details: String(e?.message || e),
    });
  }
});

// Liens televente exposes en JSON
const COMMERCE_TELEVENTE_BOSCH_URL = (process.env.COMMERCE_TELEVENTE_BOSCH_URL || "").trim();
const COMMERCE_TELEVENTE_LUB_URL   = (process.env.COMMERCE_TELEVENTE_LUB_URL   || "").trim();

app.get("/commerce/links.json", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    televenteBosch: COMMERCE_TELEVENTE_BOSCH_URL,
    televenteLub:   COMMERCE_TELEVENTE_LUB_URL,
  });
});

app.use((err, req, res, next) => {
  const url = req?.originalUrl || req?.url || "";
  console.error("[HTTP] unhandled_error", {
    method: req?.method,
    url,
    message: err?.message,
    stack: err?.stack,
  });
  next(err);
});

app.use((_req, res) => res.status(404).json({ error: "Not Found" }));

// Port d'ecoute
const PORT = process.env.PORT || 3000;

// Demarrage du serveur + initialisation stats/visites
(async () => {
  try { await stats.initCounters(); }
  catch (e) { console.warn("[COMPTEUR] initCounters souci:", e?.message || e); }
    try { await visits.initVisits(); }
  catch (e) { console.warn("[VISITS] initVisits souci:", e?.message || e); }

  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
})();
