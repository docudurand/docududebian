// serveur pour le module suivi-dossier

import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

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

// autorise l'iframe uniquement sur certains domaines
const FRAME_ANCESTORS =
  "frame-ancestors 'self' https://documentsdurand.wixsite.com https://*.wixsite.com https://*.wix.com https://*.editorx.io;";

router.use((_req, res, next) => {
  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy", FRAME_ANCESTORS);
  next();
});

// Dossier de fichiers statiques
const publicDir = path.join(__dirname, "public");

// Expose la config en JS pour la page
router.get("/config.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  res.send(
    `window.__SUIVI_CFG = {
      ATELIER_SUIVI_PASS_STE: ${JSON.stringify(SUIVI_PASS_STE)},
      ATELIER_SUIVI_PASS_BG: ${JSON.stringify(SUIVI_PASS_BG)},
      ATELIER_SUIVI_PASS_LIMITED: ${JSON.stringify(SUIVI_PASS_LIMITED)},
      ATELIER_SUIVI_PASS_CHASSE: ${JSON.stringify(SUIVI_PASS_CHASSE)},
      ATELIER_SUIVI_PASS_ADMIN: ${JSON.stringify(SUIVI_PASS_ADMIN)}
    };`
  );
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
