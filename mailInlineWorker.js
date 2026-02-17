// worker d'envoi des emails en arriere-plan

import fs from "fs";
import path from "path";
import { transporter } from "./mailer.js";
import { sendMailWithLog } from "./mailLog.js";
import {
  listReadyJobs,
  loadJob,
  saveJob,
  moveJob,
  DONE_DIR,
  FAIL_DIR,
} from "./mailQueue.js";

// Reglages de la boucle de traitement
const POLL_MS = Number(process.env.MAIL_QUEUE_POLL_MS || 1500);
const MAX_ATTEMPTS = Number(process.env.MAIL_QUEUE_MAX_ATTEMPTS || 10);
const BASE_DELAY_MS = Number(process.env.MAIL_QUEUE_BASE_DELAY_MS || 2000);

// Nettoyage automatique des vieux fichiers de queue
const CLEANUP_EVERY_MS = Number(process.env.MAIL_QUEUE_CLEANUP_EVERY_MS || 6 * 60 * 60 * 1000);
const RETENTION_DAYS_DONE = Number(process.env.MAIL_QUEUE_RETENTION_DAYS_DONE || 30);
const RETENTION_DAYS_FAILED = Number(process.env.MAIL_QUEUE_RETENTION_DAYS_FAILED || 30);
const RETENTION_DAYS_IDEM = Number(process.env.MAIL_QUEUE_RETENTION_DAYS_IDEM || 60);

// Destinataire des alertes si un mail echoue trop de fois
const FAILED_ALERT_TO = (process.env.MAIL_FAILED_ALERT_TO || "").trim();

// Pause dans la boucle
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// re-tentatives
function nextDelay(attempt) {
  const d = BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(d, 5 * 60 * 1000);
}

// Suppression securisee
function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

// Coupe un texte pour les logs
function short(s, n = 140) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
}

// Recupere le champ "to" en format texte
function getTo(mailOptions) {
  const to = mailOptions?.to;
  if (Array.isArray(to)) return to.join(", ");
  return to || "";
}

// Ne garde que les pieces jointes qui existent vraiment
function attachmentsThatExist(mailOptions) {
  const atts = Array.isArray(mailOptions?.attachments) ? mailOptions.attachments : [];
  return atts.filter((a) => a && a.path && fs.existsSync(a.path));
}

// envoi d'alerte si un job echoue au bout de 10 essais
async function sendFailedAlert({ job, formType, msg }) {
  if (!FAILED_ALERT_TO) return;
  if (!transporter) return;

  try {
    const original = job?.payload?.mailOptions || {};
    const originalTo = getTo(original);
    const originalSubject = String(original?.subject || "");
    const originalFrom = original?.from || process.env.FROM_EMAIL || process.env.SMTP_USER || "";

    const originalHtml = String(original?.html || "");
    const htmlCopy = `
      <div style="font-family:Arial,sans-serif; max-width:900px; margin:auto;">
        <h2 style="color:#c62828;">🚨 ALERTE – Mail FAILED</h2>
        <p><b>Job ID :</b> ${job?.jobId || ""}</p>
        <p><b>Formulaire :</b> ${formType}</p>
        <p><b>Tentatives :</b> ${job?.attempts || 0} / ${MAX_ATTEMPTS}</p>
        <p><b>Destinataire :</b> ${originalTo}</p>
        <p><b>Sujet :</b> ${originalSubject}</p>
        <p><b>Erreur :</b> ${String(msg || "")}</p>
        <hr/>
        <p>📎 Une copie du mail original est jointe en <code>mail-original.html</code>.</p>
      </div>
    `;

    const alertAttachments = [
      {
        filename: "mail-original.html",
        content: originalHtml || "<!-- (mail original vide) -->",
        contentType: "text/html; charset=utf-8",
      },
      ...attachmentsThatExist(original),
    ];

    await transporter.sendMail({
      from: originalFrom ? `"DSG Mailer" <${originalFrom}>` : undefined,
      to: FAILED_ALERT_TO,
      subject: `🚨 ALERTE – Mail FAILED (${formType})`,
      html: htmlCopy,
      attachments: alertAttachments,
    });

    console.log("[INLINE_MAIL_WORKER] failed-alert sent for", job?.jobId);
  } catch (e) {
    console.warn("[INLINE_MAIL_WORKER] failed-alert error:", e?.message || e);
  }
}

// Traite un seul job de la file d'attente
async function processOne(jobFile) {
  const job = loadJob(jobFile);
  if (!job) {
    try {
      console.warn("[INLINE_MAIL_WORKER] invalid job file -> failed:", jobFile);
      moveJob(jobFile, FAIL_DIR);
    } catch {}
    return;
  }

  if (job.nextAttemptAt && Date.now() < job.nextAttemptAt) return;

  job.status = "sending";
  saveJob(jobFile, job);

  const mailOptions = job?.payload?.mailOptions || {};
  const to = getTo(mailOptions);
  const subject = mailOptions?.subject || "";
  const formType = job?.payload?.formType || "unknown";

  const prevAttempts = job?.attempts || 0;
  const attemptNow = prevAttempts + 1;
  const isFinalAttempt = attemptNow >= MAX_ATTEMPTS;

  console.log(
    "[INLINE_MAIL_WORKER] sending",
    job.jobId,
    "| formType=",
    formType,
    "| to=",
    short(to, 120),
    "| subject=",
    short(subject, 120),
    "| attempt=",
    attemptNow,
    "/",
    MAX_ATTEMPTS
  );

  try {
    const metaWithAttempt = {
      ...(job?.payload?.meta || {}),
      attempt: attemptNow,
      maxAttempts: MAX_ATTEMPTS,
    };

    await sendMailWithLog(
      transporter,
      mailOptions,
      formType,
      metaWithAttempt,
      { logFailed: isFinalAttempt }
    );

    // Nettoyage des fichiers temporaires
    (job?.payload?.cleanupPaths || []).forEach(safeUnlink);

    job.status = "sent";
    job.sentAt = new Date().toISOString();
    saveJob(jobFile, job);
    moveJob(jobFile, DONE_DIR);

    console.log("[INLINE_MAIL_WORKER] sent", job.jobId);
  } catch (e) {
    const msg = String(e?.message || e);

    job.attempts = attemptNow;
    job.lastError = msg;

    console.warn("[INLINE_MAIL_WORKER] error", job.jobId, "|", short(msg, 200));

    if (attemptNow >= MAX_ATTEMPTS) {
      await sendFailedAlert({ job, formType, msg });
      (job?.payload?.cleanupPaths || []).forEach(safeUnlink);

      job.failedAt = new Date().toISOString();
      saveJob(jobFile, job);
      moveJob(jobFile, FAIL_DIR);

      console.warn("[INLINE_MAIL_WORKER] moved to failed", job.jobId);
    } else {
      job.nextAttemptAt = Date.now() + nextDelay(attemptNow);
      saveJob(jobFile, job);

      console.log(
        "[INLINE_MAIL_WORKER] retry scheduled",
        job.jobId,
        "in",
        Math.round((job.nextAttemptAt - Date.now()) / 1000),
        "s"
      );
    }
  }
}

// Lecture JSON simple
function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8") || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

// ecriture atomique pour ne pas corrompre les fichiers
function writeJsonAtomic(file, obj) {
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// Liste les fichiers JSON d'un dossier
function listJsonFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// Age du fichier en millisecondes
function fileAgeMs(file) {
  try {
    const st = fs.statSync(file);
    return Date.now() - st.mtimeMs;
  } catch {
    return 0;
  }
}

// Supprime les vieux fichiers d'un dossier
function deleteIfOlderThan(dir, retentionDays) {
  const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const f of listJsonFiles(dir)) {
    if (fileAgeMs(f) > cutoffMs) {
      try {
        fs.unlinkSync(f);
        removed++;
      } catch {}
    }
  }
  return removed;
}

// Nettoie l'index
function cleanupIdemIndex(queueDir) {
  const file = path.join(queueDir, "idem-index.json");
  const idx = safeReadJson(file, {});
  if (!idx || typeof idx !== "object") return { kept: 0, removed: 0 };

  const allJobIds = new Set();
  for (const dir of [
    path.join(queueDir, "ready"),
    path.join(queueDir, "done"),
    path.join(queueDir, "failed"),
  ]) {
    for (const f of listJsonFiles(dir)) {
      allJobIds.add(path.basename(f).replace(/\.json$/i, ""));
    }
  }

  let removed = 0;
  const out = {};
  for (const [k, jobId] of Object.entries(idx)) {
    if (typeof jobId === "string" && allJobIds.has(jobId)) out[k] = jobId;
    else removed++;
  }

  writeJsonAtomic(file, out);
  return { kept: Object.keys(out).length, removed };
}

// Lance un nettoyage complet des fichiers de queue
async function runCleanupOnce() {
  const queueDir = path.resolve(DONE_DIR, "..");

  const removedDone = deleteIfOlderThan(DONE_DIR, RETENTION_DAYS_DONE);
  const removedFailed = deleteIfOlderThan(FAIL_DIR, RETENTION_DAYS_FAILED);

  const idemFile = path.join(queueDir, "idem-index.json");
  const idemTooOld =
    fs.existsSync(idemFile) &&
    fileAgeMs(idemFile) > RETENTION_DAYS_IDEM * 24 * 60 * 60 * 1000;

  const idemResult = cleanupIdemIndex(queueDir);

  console.log(
    "[INLINE_MAIL_WORKER][CLEANUP]",
    "done_removed=",
    removedDone,
    "failed_removed=",
    removedFailed,
    "idemTooOld=",
    idemTooOld,
    "idem_kept=",
    idemResult.kept,
    "idem_removed=",
    idemResult.removed
  );
}

let nextCleanupAt = Date.now() + 15 * 1000;

// Boucle principale du worker (tourne en continu)
(async function loop() {
  console.log("[INLINE_MAIL_WORKER] started");

  while (true) {
    try {
      const jobs = listReadyJobs();
      for (const jf of jobs) await processOne(jf);
    } catch (e) {
      console.warn("[INLINE_MAIL_WORKER] loop error:", e?.message || e);
    }

    if (Date.now() >= nextCleanupAt) {
      try {
        await runCleanupOnce();
      } catch (e) {
        console.warn("[INLINE_MAIL_WORKER][CLEANUP] error:", e?.message || e);
      }
      nextCleanupAt = Date.now() + CLEANUP_EVERY_MS;
    }

    await sleep(POLL_MS);
  }
})();
