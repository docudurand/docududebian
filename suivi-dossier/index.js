// serveur pour le module suivi-dossier

import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";

// Chemins utilitaires
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// routeur Express separe
const router = express.Router();

// Mots de passe pour les acces
const SUIVI_PASS_STE     = process.env.ATELIER_SUIVI_PASS_STE     || "";
const SUIVI_PASS_BG      = process.env.ATELIER_SUIVI_PASS_BG      || "";
const SUIVI_PASS_LIMITED = process.env.ATELIER_SUIVI_PASS_LIMITED || "";
const SUIVI_PASS_CHASSE = process.env.ATELIER_SUIVI_PASS_CHASSE || "";
const SUIVI_PASS_ADMIN = process.env.ATELIER_SUIVI_PASS_ADMIN || "";

const suiviLoginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.SUIVI_LOGIN_RATE_LIMIT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "too_many_attempts" },
});

function resolveSuiviRole(password) {
  const pw = String(password || "").trim();
  if (!pw) return null;

  if (SUIVI_PASS_STE && pw === SUIVI_PASS_STE) return "STE";
  if (SUIVI_PASS_BG && pw === SUIVI_PASS_BG) return "BG";
  if (SUIVI_PASS_CHASSE && pw === SUIVI_PASS_CHASSE) return "CHASSE";
  if (SUIVI_PASS_LIMITED && pw === SUIVI_PASS_LIMITED) return "LIMITED";
  if (SUIVI_PASS_ADMIN && pw === SUIVI_PASS_ADMIN) return "ADMIN";
  return null;
}

function asSessionPayload(role) {
  const r = String(role || "").toUpperCase();
  return {
    role: r,
    isLimited: r === "LIMITED",
    viewMode: r === "LIMITED" ? "ALL" : r,
  };
}

// autorise l'iframe uniquement sur certains domaines
const FRAME_ANCESTORS =
  "frame-ancestors 'self' https://documentsdurand.wixsite.com https://*.wixsite.com https://*.wix.com https://*.editorx.io;";

router.use((_req, res, next) => {
  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy", FRAME_ANCESTORS);
  next();
});

router.use(express.json({ limit: "1mb" }));

// Dossier de fichiers statiques
const publicDir = path.join(__dirname, "public");

// Expose la config en JS pour la page
router.get("/config.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send("window.__SUIVI_CFG = {};");
});

router.post("/api/login", suiviLoginLimiter, (req, res) => {
  const hasAnyPassword = Boolean(
    SUIVI_PASS_STE || SUIVI_PASS_BG || SUIVI_PASS_LIMITED || SUIVI_PASS_CHASSE || SUIVI_PASS_ADMIN
  );
  if (!hasAnyPassword) {
    return res.status(503).json({ success: false, message: "suivi_password_not_configured" });
  }
  const role = resolveSuiviRole(req.body?.password);
  if (!role) {
    return res.status(401).json({ success: false, message: "Mot de passe incorrect." });
  }

  return req.session.regenerate((regenErr) => {
    if (regenErr) {
      return res.status(500).json({ success: false, message: "session_error" });
    }
    const payload = asSessionPayload(role);
    req.session.atelierSuiviAuth = {
      ...payload,
      loginAt: new Date().toISOString(),
    };
    return req.session.save((saveErr) => {
      if (saveErr) {
        return res.status(500).json({ success: false, message: "session_save_failed" });
      }
      return res.json({ success: true, ...payload });
    });
  });
});

router.get("/api/session", (req, res) => {
  const auth = req.session?.atelierSuiviAuth || null;
  if (!auth) return res.status(401).json({ success: false });
  return res.json({ success: true, role: auth.role, isLimited: !!auth.isLimited, viewMode: auth.viewMode || "ALL" });
});

router.post("/api/logout", (req, res) => {
  req.session.atelierSuiviAuth = null;
  req.session.save(() => res.sendStatus(204));
});

// Pages statiques
router.use(express.static(publicDir, {
  extensions: ["html", "htm"],
  index: false,
  setHeaders: (res, p) => {
    res.setHeader("Content-Security-Policy", FRAME_ANCESTORS);
    if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
  }
}));

// Page principale
router.get("/", (_req, res) => {
  const f = path.join(publicDir, "index.html");
  if (fs.existsSync(f)) return res.sendFile(f);
  res.status(500).type("text").send("suivi-dossier/public/index.html introuvable.");
});

router.get("/healthz", (_req, res) => res.type("text").send("ok"));

export default router;
