// formulaire creation reference VL (upload + envoi email)

import express from "express";
import multer from "multer";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import crypto from "crypto";

import { fromEmail } from "../mailer.js";
import { enqueueMailJob, getIdempotencyKey } from "../mailQueue.js";

// Chargement des variables d'environnement
dotenv.config();

// routeur Express separe
const router = express.Router();

const FORM_ALLOWED_ORIGINS = String(
  process.env.FORM_ALLOWED_ORIGINS || "https://documentsdurand.fr,https://www.documentsdurand.fr"
)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const formCorsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (FORM_ALLOWED_ORIGINS.includes(String(origin).trim())) return cb(null, true);
    return cb(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
};

const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.FORM_SUBMIT_RATE_LIMIT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: "Trop de requetes, reessayez plus tard.",
});

router.use(cors(formCorsOptions));
router.options("*", cors(formCorsOptions));
router.use(express.urlencoded({ extended: true }));
router.use(express.json({ limit: "15mb" }));

router.get("/healthz", (_req, res) => res.sendStatus(200));
router.get("/", (_req, res) => res.send("✅ Formulaire Création Référence VL – OK"));

// dossier d'upload (doit etre accessible en ecriture)
const UPLOAD_DIR = (process.env.UPLOAD_DIR || "/var/data/uploads").trim();
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch {}

// Stockage des pieces jointes sur disque
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = String(file.originalname || "file")
      .replace(/[^\w.\-() ]+/g, "_")
      .slice(0, 160);
    cb(null, `${Date.now()}-${safe}`);
  },
});

// Configuration multer (taille + filtre de fichiers)
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const forbidden = /\.(exe|bat|sh|cmd|js)$/i;
    if (forbidden.test(file.originalname || "")) {
      return cb(new Error("Type de fichier non autorisé."), false);
    }
    cb(null, true);
  },
});

// Libelles pour le mail HTML
const FIELD_LABELS = {
  email: "Adresse e-mail",
  marque: "Marque",
  fournisseur: "Fournisseur de Réappro",
  reference: "Référence",
  designation: "Désignation pièce (Si en Anglais)",
  tarif: "Tarif",
  remise: "Remise",
};

// HTML non exécuté
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function valueOrEmpty(v) {
  return v !== undefined && v !== null && String(v).trim() !== ""
    ? escapeHtml(String(v))
    : "<em>(non renseigné)</em>";
}

// Mail HTML pour le magasin
function generateHtml(data = {}) {
  const rows = Object.entries(FIELD_LABELS)
    .map(
      ([key, label]) => `
      <tr>
        <td style="padding:8px; border:1px solid #ccc; background:#f8f8f8; font-weight:bold;">
          ${escapeHtml(label)}
        </td>
        <td style="padding:8px; border:1px solid #ccc;">
          ${valueOrEmpty(data[key])}
        </td>
      </tr>
    `
    )
    .join("");

  return `
    <div style="font-family:Arial,sans-serif; max-width:700px; margin:auto;">
      <h2 style="color:#007bff; text-align:center;">🔧 Formulaire Création Référence VL</h2>
      <table style="width:100%; border-collapse:collapse; margin-top:20px;">
        ${rows}
      </table>
      <p style="margin-top:20px;">📎 Des fichiers sont joints à ce message si fournis.</p>
    </div>
  `;
}

// Mail HTML d'accuse de reception (demandeur)
function accuseHtml(data = {}) {
  const rows = Object.entries(FIELD_LABELS)
    .map(
      ([key, label]) => `
      <tr>
        <td style="padding:6px; border:1px solid #eee; background:#f8f8f8; font-weight:bold;">
          ${escapeHtml(label)}
        </td>
        <td style="padding:6px; border:1px solid #eee;">
          ${valueOrEmpty(data[key])}
        </td>
      </tr>
    `
    )
    .join("");

  return `
    <div style="font-family:Arial,sans-serif; max-width:700px; margin:auto;">
      <h2 style="text-align:center; color:#28a745;">✔️ Accusé de réception</h2>
      <p>Votre demande de création de référence VL a bien été enregistrée.</p>
      <table style="width:100%; border-collapse:collapse; margin-top:20px;">
        ${rows}
      </table>
      <p style="margin-top:20px;">Ceci est un accusé automatique, merci de ne pas répondre.</p>
    </div>
  `;
}

// Envoi du formulaire (stockage + mise en file d'attente email)
router.post("/submit-form", submitLimiter, upload.array("fichiers[]", 10), async (req, res) => {
  const formData = req.body || {};
  const files = Array.isArray(req.files) ? req.files : [];

  const attachments = files.map((f) => ({
    filename: f.originalname,
    path: f.path,
  }));
  const attachmentPaths = attachments.map((a) => a.path).filter(Boolean);

  try {
    const to =
      process.env.DEST_EMAIL_FORMULAIRE_CREATION_VL ||
      process.env.DEST_EMAIL_FORMULAIRE_PIECE ||
      "";

    if (!to) {
      console.error("[creation-reference-vl] DEST_EMAIL_FORMULAIRE_CREATION_VL missing");
      return res.status(500).send("Erreur: destinataire non configuré.");
    }

    // pour eviter les doublons
    const requestId =
      getIdempotencyKey(req) ||
      (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));

    await enqueueMailJob({
      idempotencyKey: `${requestId}:creation-reference-vl:magasin`,
      mailOptions: {
        from: `"Formulaire création VL" <${fromEmail}>`,
        to,
        subject: "📨 Demande de création référence VL",
        replyTo: formData.email || undefined,
        html: generateHtml(formData),
        attachments,
      },
      formType: "creation-reference-vl",
      meta: {
        kind: "magasin",
        demandeur: formData.email || "",
        marque: (formData.marque || "").slice(0, 80),
        fournisseur: (formData.fournisseur || "").slice(0, 80),
        reference: (formData.reference || "").slice(0, 80),
      },
      cleanupPaths: formData.email ? [] : attachmentPaths,
    });

    if (formData.email) {
      await enqueueMailJob({
        idempotencyKey: `${requestId}:creation-reference-vl:demandeur`,
        mailOptions: {
          from: `"Formulaire création VL" <${fromEmail}>`,
          to: formData.email,
          subject: "Votre demande de création de référence a bien été reçue",
          html: accuseHtml(formData),
          attachments,
        },
        formType: "creation-reference-vl",
        meta: { kind: "demandeur", demandeur: formData.email || "" },
        cleanupPaths: attachmentPaths,
      });
    }

    return res.status(202).send("Formulaire enregistré. Envoi en cours…");
  } catch (err) {
    console.error("[creation-reference-vl] enqueue failed:", err);
    return res.status(500).send("Erreur lors de l'envoi.");
  }
});

export default router;
