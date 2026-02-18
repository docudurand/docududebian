// routes API kilometrage — stockage FTP JSON
// Structure : {KM_FTP_DIR}/{CODEAGENCE}/{YYYY-MM}.json
//
// Concurrence : file d'attente en mémoire par clé de fichier.
// Les 5 livreurs d'un même magasin qui envoient en même temps
// sont sérialisés → pas de perte de données par race condition.
//
// ─────────────────────────────────────────────────────────
// Format params.json  (à la racine de KM_FTP_DIR)
// ─────────────────────────────────────────────────────────
// [
//   {
//     "agence":           "Gleize",      // nom d'affichage
//     "codeAgence":       "GLEIZE",      // code = nom du sous-dossier FTP
//     "tournee":          "Tournée 1",
//     "codeTournee":      "T1",
//     "transporteur":     "Dupont J.",   // chauffeur actuel
//     "codeTransporteur": "DJ",
//     "id":               "T1-001",      // identifiant QR code
//     "dernierRemplacement": null        // ISO date ou null
//   }
// ]
//
// ─────────────────────────────────────────────────────────
// Format {CODEAGENCE}/{YYYY-MM}.json
// ─────────────────────────────────────────────────────────
// [
//   {
//     "type":          "releve" | "absence",
//     "id":            "T1-001",
//     "agence":        "Gleize",
//     "codeAgence":    "GLEIZE",
//     "tournee":       "Tournée 1",
//     "codeTournee":   "T1",
//     "chauffeur":     "Dupont J.",
//     "codeChauffeur": "DJ",
//     "date":          "2026-02-18",    // YYYY-MM-DD
//     "km":            12345,           // null pour une absence
//     "horaire":       "depart",        // null pour une absence
//     "commentaire":   "",
//     "note":          "",              // pour les absences
//     "createdAt":     "2026-02-18T08:30:00.000Z"
//   }
// ]

import express from "express";
import ftp from "basic-ftp";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

// ═══════════════════════════════════════════════════════════
// Configuration FTP
// ═══════════════════════════════════════════════════════════
function getFtpConfig() {
  const host     = String(process.env.FTP_HOST     || "").trim();
  const user     = String(process.env.FTP_USER     || "").trim();
  const password = String(process.env.FTP_PASS     || process.env.FTP_PASSWORD || "").trim();
  const port     = process.env.FTP_PORT ? Number(process.env.FTP_PORT) : 21;
  const secure   = String(process.env.FTP_SECURE   || "false").toLowerCase() === "true";
  // rejectUnauthorized : true par défaut (mettre FTP_TLS_REJECT_UNAUTH=0 pour dev)
  const rejectUnauthorized = String(process.env.FTP_TLS_REJECT_UNAUTH || "").trim() !== "0";
  const insecure           = String(process.env.FTP_TLS_INSECURE      || "").trim() === "1";
  const baseDir  = String(process.env.KM_FTP_DIR   || process.env.FTP_BASE_DIR || "/kilometrage")
    .trim().replace(/\/+$/, "");
  return { host, user, password, port, secure, rejectUnauthorized, insecure, baseDir };
}

// ─── Chemins et helpers ──────────────────────────────────

/**
 * Normalise un codeAgence en nom de dossier FTP sûr.
 * "CHASSE SUR RHONE" → "CHASSE_SUR_RHONE"
 */
function sanitizeAgenceCode(code) {
  return String(code || "INCONNU")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")          // espaces → _
    .replace(/[^A-Z0-9_\-]/g, ""); // garde alphanum, _ et -
}

/** Chemin FTP du fichier mensuel : /kilometrage/GLEIZE/2026-02.json */
function monthlyRemotePath(codeAgence, yearMonth) {
  const { baseDir } = getFtpConfig();
  const dir = sanitizeAgenceCode(codeAgence);
  return path.posix.join(baseDir, dir, `${yearMonth}.json`);
}

/** Chemin FTP du fichier params.json global */
function paramsRemotePath() {
  const { baseDir } = getFtpConfig();
  return path.posix.join(baseDir, "params.json");
}

/** Extrait YYYY-MM depuis une date YYYY-MM-DD */
function toYearMonth(dateStr) {
  const s = String(dateStr || "").trim();
  if (s.length >= 7) return s.slice(0, 7);
  return new Date().toISOString().slice(0, 7);
}

// ═══════════════════════════════════════════════════════════
// File d'attente par fichier — protection contre la concurrence
// ═══════════════════════════════════════════════════════════
//
// Problème sans verrou :
//   Livreur A (T1)  : lit [rec1]           → ajoute recA → écrit [rec1, recA]
//   Livreur B (T2)  : lit [rec1]           → ajoute recB → écrit [rec1, recB]
//   Résultat : recA ou recB est perdu selon qui écrit en dernier.
//
// Avec la queue :
//   Livreur A : lit [rec1], ajoute recA, écrit [rec1, recA]  ← s'exécute en premier
//   Livreur B : attend que A termine, lit [rec1, recA], ajoute recB, écrit [rec1, recA, recB]
//   Résultat : aucune perte de données.
//
// Chaque clé de fichier (ex: "GLEIZE/2026-02") a sa propre chaîne de promesses.
// La map est nettoyée automatiquement quand la chaîne se vide.

const writeQueues = new Map(); // Map<string, Promise<void>>

/**
 * Exécute `fn` en exclusion mutuelle pour la clé `key`.
 * Les appels concurrents sont mis en file et exécutés dans l'ordre FIFO.
 * @param {string} key    - identifiant du fichier cible
 * @param {Function} fn   - async function () => any
 * @returns {Promise<any>}
 */
function withFileLock(key, fn) {
  const current = writeQueues.get(key) ?? Promise.resolve();
  const next = current
    .then(fn)
    .finally(() => {
      // Ne nettoyer que si aucune nouvelle opération n'a été ajoutée entre-temps
      if (writeQueues.get(key) === next) {
        writeQueues.delete(key);
      }
    });
  writeQueues.set(key, next);
  return next;
}

// ═══════════════════════════════════════════════════════════
// Couche FTP
// ═══════════════════════════════════════════════════════════

function tmpFile(prefix) {
  const rnd = crypto.randomBytes(6).toString("hex");
  return path.join(os.tmpdir(), `km_${prefix}_${Date.now()}_${rnd}`);
}

async function connectFtp() {
  const cfg = getFtpConfig();
  if (!cfg.host || !cfg.user || !cfg.password) {
    throw new Error("FTP_HOST, FTP_USER ou FTP_PASS manquants pour le kilométrage");
  }
  const client = new ftp.Client(30_000);
  client.ftp.verbose = false;
  await client.access({
    host:    cfg.host,
    user:    cfg.user,
    password: cfg.password,
    port:    cfg.port,
    secure:  cfg.secure,
    secureOptions: {
      rejectUnauthorized: cfg.rejectUnauthorized && !cfg.insecure,
      servername: cfg.host || undefined,
    },
  });
  try { client.ftp.socket?.setKeepAlive?.(true, 10_000); } catch {}
  return client;
}

async function withFtp(fn) {
  let client;
  try {
    client = await connectFtp();
    return await fn(client);
  } finally {
    try { client?.close(); } catch {}
  }
}

/** Lit un fichier JSON depuis le FTP. Retourne null si inexistant (550). */
async function ftpReadJson(remoteFtpPath) {
  const tmp = tmpFile("read");
  return withFtp(async (client) => {
    try {
      await client.downloadTo(tmp, remoteFtpPath);

      const raw = fs.readFileSync(tmp, "utf8");
      const trimmed = raw.trim();

      // Fichier vide / partiel => on considère absent (évite les 500)
      if (!trimmed) return null;

      try {
        return JSON.parse(trimmed);
      } catch (parseErr) {
        console.error(
          "[KM] JSON invalide sur FTP :",
          remoteFtpPath,
          "->",
          parseErr?.message || parseErr
        );
        // On ignore ce fichier au lieu de faire tomber l'API
        return null;
      }
    } catch (err) {
      const msg = String(err?.message || "");
      // 550 : fichier absent côté FTP
      if (msg.includes("550") || msg.includes("ENOENT")) return null;
      throw err;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  });
}

/** Écrit un fichier JSON sur le FTP (crée le dossier parent si besoin). */
async function ftpWriteJson(remoteFtpPath, data) {
  const tmp = tmpFile("write");
  return withFtp(async (client) => {
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
      await client.ensureDir(path.posix.dirname(remoteFtpPath));
      await client.uploadFrom(tmp, remoteFtpPath);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });
}

// ═══════════════════════════════════════════════════════════
// Opérations métier
// ═══════════════════════════════════════════════════════════

/** Lit les relevés mensuels d'un magasin (lecture simple, sans verrou). */
async function readMonthlyRecords(codeAgence, yearMonth) {
  const remote = monthlyRemotePath(codeAgence, yearMonth);
  const data = await ftpReadJson(remote);
  return Array.isArray(data) ? data : [];
}

/**
 * Ajoute un relevé dans le fichier mensuel du magasin.
 * Sérialisé par la file d'attente si des appels concurrents arrivent.
 */
async function appendRecord(record) {
  const codeAgence = sanitizeAgenceCode(record.codeAgence || record.agence);
  const yearMonth  = toYearMonth(record.date);
  const key        = `${codeAgence}/${yearMonth}`;
  const remote     = monthlyRemotePath(codeAgence, yearMonth);

  return withFileLock(key, async () => {
    // read-modify-write atomique pour ce fichier
    const existing = await ftpReadJson(remote);
    const records  = Array.isArray(existing) ? existing : [];
    records.push(record);
    await ftpWriteJson(remote, records);
  });
}

/** Met à jour params.json avec verrou (un seul écrivain à la fois). */
async function updateParams(updaterFn) {
  return withFileLock("_params", async () => {
    const existing = await ftpReadJson(paramsRemotePath());
    const params   = Array.isArray(existing) ? existing : [];
    const updated  = updaterFn(params);
    await ftpWriteJson(paramsRemotePath(), updated);
    return updated;
  });
}

// ═══════════════════════════════════════════════════════════
// Routes Express
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/kilometrage/params?agence=GLEIZE
 * Retourne les lignes de paramétrage (toutes si pas de filtre agence).
 */
router.get("/params", async (req, res) => {
  try {
    const agenceRaw = String(req.query.agence || "").trim();
    const params = await ftpReadJson(paramsRemotePath());
    const all = Array.isArray(params) ? params : [];

    const result = agenceRaw
      ? all.filter(p => {
          const ag = agenceRaw.toLowerCase();
          return String(p.agence    || "").toLowerCase() === ag ||
                 String(p.codeAgence || "").toLowerCase() === ag;
        })
      : all;

    return res.json(result);
  } catch (err) {
    console.error("Erreur /api/kilometrage/params :", err.message || err);
    return res.status(500).json({ success: false, error: "Erreur récupération des paramètres" });
  }
});

/**
 * POST /api/kilometrage/newid
 * Body: { agence, codeTournee }
 * Génère un nouvel ID de QR code pour une tournée (changement de chauffeur).
 */
router.post("/newid", async (req, res) => {
  try {
    const { agence, codeTournee } = req.body || {};
    if (!agence || !codeTournee) {
      return res.status(400).json({ success: false, error: "Champs manquants (agence / codeTournee)" });
    }

    let newId;

    await updateParams((params) => {
      const codeTourneeStr = String(codeTournee).trim();
      const agLower = String(agence).toLowerCase();

      // Calculer le prochain numéro séquentiel pour ce code tournée
      const sameCode = params.filter(p => String(p.codeTournee || "").trim() === codeTourneeStr);
      let maxSeq = 0;
      for (const p of sameCode) {
        const seq = parseInt(String(p.id || "").split("-").pop(), 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
      newId = `${codeTourneeStr}-${String(maxSeq + 1).padStart(3, "0")}`;

      const now = new Date().toISOString();

      // Référence pour copier les métadonnées de la tournée
      const ref = sameCode.find(p =>
        String(p.agence    || "").toLowerCase() === agLower ||
        String(p.codeAgence || "").toLowerCase() === agLower
      ) || sameCode[0] || {};

      // Marquer la date de remplacement sur la ligne active de ce magasin
      const updated = params.map(p => {
        if (
          String(p.codeTournee || "").trim() === codeTourneeStr &&
          (String(p.agence    || "").toLowerCase() === agLower ||
           String(p.codeAgence || "").toLowerCase() === agLower)
        ) {
          return { ...p, dernierRemplacement: now };
        }
        return p;
      });

      // Nouvelle ligne (chauffeur à renseigner via l'interface admin)
      updated.push({
        agence:              ref.agence     || agence,
        codeAgence:          ref.codeAgence || agence,
        tournee:             ref.tournee    || "",
        codeTournee:         codeTourneeStr,
        transporteur:        "",
        codeTransporteur:    "",
        id:                  newId,
        dernierRemplacement: null,
      });

      return updated;
    });

    console.log(`[KM] newid: ${newId} (tournée ${codeTournee}, agence ${agence})`);
    return res.json({ success: true, id: newId });
  } catch (err) {
    console.error("Erreur /api/kilometrage/newid :", err.message || err);
    return res.status(500).json({ success: false, error: "Erreur génération du nouvel ID" });
  }
});

/**
 * POST /api/kilometrage/absent
 * Body: { agence, codeAgence, tournee, codeTournee, chauffeur, codeChauffeur, date, note }
 * Enregistre une absence dans le fichier mensuel du magasin.
 */
router.post("/absent", async (req, res) => {
  try {
    const {
      agence, codeAgence, tournee, codeTournee,
      chauffeur, codeChauffeur, date, note
    } = req.body || {};

    if (!agence || !codeTournee || !date) {
      return res.status(400).json({
        success: false,
        error: "Champs obligatoires manquants (agence, codeTournee, date)"
      });
    }

    const record = {
      type:          "absence",
      id:            null,
      agence:        String(agence       || ""),
      codeAgence:    String(codeAgence   || agence || ""),
      tournee:       String(tournee      || ""),
      codeTournee:   String(codeTournee  || ""),
      chauffeur:     String(chauffeur    || ""),
      codeChauffeur: String(codeChauffeur || ""),
      date:          String(date).slice(0, 10),
      km:            null,
      horaire:       null,
      commentaire:   "",
      note:          String(note || ""),
      createdAt:     new Date().toISOString(),
    };

    await appendRecord(record);

    console.log(`[KM] absent: ${record.codeAgence}/${record.codeTournee} le ${record.date}`);
    return res.json({ success: true });
  } catch (err) {
    console.error("Erreur /api/kilometrage/absent :", err.message || err);
    return res.status(500).json({ success: false, error: "Erreur déclaration d'absence" });
  }
});

/**
 * POST /api/kilometrage/save
 * Body: { agence, codeAgence, tournee, codeTournee, chauffeur, codeChauffeur,
 *         date, km, commentaire, id, horaire }
 *
 * Enregistre un relevé kilométrique.
 * Si plusieurs livreurs du même magasin envoient simultanément,
 * leurs écritures sont sérialisées par la file d'attente.
 */
router.post("/save", async (req, res) => {
  try {
    const {
      agence, codeAgence, tournee, codeTournee,
      chauffeur, codeChauffeur, date, km, commentaire, id, horaire
    } = req.body || {};

    if (!agence || !date) {
      return res.status(400).json({
        success: false,
        error: "Champs obligatoires manquants (agence, date)"
      });
    }

    const kmNumber = Number(km);
    if (isNaN(kmNumber) || kmNumber < 0) {
      return res.status(400).json({ success: false, error: "Valeur km invalide" });
    }

    const record = {
      type:          "releve",
      id:            (id === null || typeof id === "undefined" || String(id).trim()==="") ? null : String(id).trim(),
      agence:        String(agence        || ""),
      codeAgence:    String(codeAgence    || agence || ""),
      tournee:       String(tournee       || ""),
      codeTournee:   String(codeTournee   || ""),
      chauffeur:     String(chauffeur     || ""),
      codeChauffeur: String(codeChauffeur || ""),
      date:          String(date).slice(0, 10),
      km:            kmNumber,
      horaire:       String(horaire || "").toLowerCase().trim(),
      commentaire:   String(commentaire   || ""),
      note:          "",
      createdAt:     new Date().toISOString(),
    };

    await appendRecord(record);

    console.log(`[KM] save: ${record.codeAgence}/${record.codeTournee} ${record.date} → ${kmNumber} km`);
    return res.json({ success: true });
  } catch (err) {
    console.error("Erreur /api/kilometrage/save :", err.message || err);
    return res.status(500).json({ success: false, error: "Erreur enregistrement kilométrage" });
  }
});

/**
 * GET /api/kilometrage/data?agence=GLEIZE&year=2026
 * Retourne tous les relevés de l'année pour un magasin.
 * Les 12 fichiers mensuels sont lus en parallèle (lectures seules → pas de verrou).
 */
router.get("/data", async (req, res) => {
  try {
    const agenceRaw = String(req.query.agence || "").trim();
    const yearRaw   = String(req.query.year   || "").trim();
    const year      = yearRaw || String(new Date().getFullYear());

    if (!agenceRaw) {
      return res.status(400).json({ success: false, error: "Paramètre agence manquant" });
    }

    // Lecture séquentielle : 1 connexion FTP à la fois
    // (la Freebox limite les connexions simultanées par compte FTP)
    const allRecords = [];
    for (let i = 1; i <= 12; i++) {
      const month = String(i).padStart(2, "0");
      try {
        const records = await readMonthlyRecords(agenceRaw, `${year}-${month}`);
        allRecords.push(...records);
      } catch (e) {
        console.error("[KM] Lecture mois KO", agenceRaw, `${year}-${month}`, e?.message || e);
        // On continue sur les autres mois
      }
    }

    return res.json(allRecords);
  } catch (err) {
    console.error("Erreur /api/kilometrage/data :", err.message || err);
    return res.status(500).json({ success: false, error: "Erreur récupération des données" });
  }
});

/**
 * GET /api/kilometrage/resume?agence=GLEIZE&date=2026-02-18
 * Retourne les relevés du jour. Lit uniquement le fichier mensuel concerné.
 */
router.get("/resume", async (req, res) => {
  try {
    const agenceRaw      = String(req.query.agence || "").trim();
    const date           = String(req.query.date   || "").trim();
    const idRaw          = (req.query.id !== undefined) ? String(req.query.id).trim() : "";
    const codeTourneeRaw = (req.query.codeTournee !== undefined) ? String(req.query.codeTournee).trim() : "";
    const codeChauffeurRaw = (req.query.codeChauffeur !== undefined) ? String(req.query.codeChauffeur).trim() : "";

    if (!agenceRaw || !date) {
      return res.status(400).json({ success: false, error: "Paramètres manquants (agence / date)" });
    }

    const yearMonth = toYearMonth(date);
    const day       = date.slice(0, 10);
    const records   = await readMonthlyRecords(agenceRaw, yearMonth);

    let filtered = records.filter(r => String(r.date || "").slice(0, 10) === day);

    // Filtres optionnels (utile pour la page de saisie)
    if (idRaw) {
      filtered = filtered.filter(r => String(r.id || "").trim() === idRaw);
    }
    if (codeTourneeRaw) {
      filtered = filtered.filter(r => String(r.codeTournee || "").trim() === codeTourneeRaw);
    }
    if (codeChauffeurRaw) {
      filtered = filtered.filter(r => String(r.codeChauffeur || "").trim() === codeChauffeurRaw);
    }

    return res.json({ success: true, rows: filtered });
  } catch (err) {
    console.error("Erreur /api/kilometrage/resume :", err.message || err);
    return res.status(500).json({ success: false, error: "Erreur récupération du résumé" });
  }
});});

/**
 * GET /api/kilometrage/healthz
 * Vérifie la connexion FTP et retourne l'état de la queue.
 */
router.get("/healthz", async (req, res) => {
  try {
    const { baseDir } = getFtpConfig();
    await withFtp(async (client) => {
      await client.ensureDir(baseDir);
    });
    return res.json({
      success:       true,
      dir:           baseDir,
      pendingWrites: writeQueues.size,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

export default router;
