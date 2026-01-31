// Module de stockage FTP pour les prêts de véhicules
// Version corrigée compatible basic-ftp

import ftp from 'basic-ftp';
import { Writable, Readable } from 'stream';
import crypto from 'crypto';

// Configuration FTP depuis les variables d'environnement
const FTP_CONFIG = {
  host: process.env.FTP_HOST,
  user: process.env.FTP_USER,
  password: process.env.FTP_PASSWORD,
  port: parseInt(process.env.FTP_PORT || '21'),
  secure: process.env.FTP_SECURE === 'true',
  secureOptions: { 
    rejectUnauthorized: process.env.FTP_TLS_REJECT_UNAUTH !== '0' 
  }
};

// Chemin du fichier JSON sur le FTP
const LOANS_FILE_PATH = process.env.FTP_BACKUP_FOLDER 
  ? `${process.env.FTP_BACKUP_FOLDER}/pret_vehicules.json`
  : '/Disque 1/service/pret_vehicules.json';

// Structure de données par défaut
const DEFAULT_DATA = {
  vehicles: [],
  stores: [],
  loans: [],
  lastUpdate: new Date().toISOString()
};

/**
 * Crée et configure un client FTP
 */
async function createFtpClient() {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  
  try {
    await client.access(FTP_CONFIG);
    return client;
  } catch (error) {
    throw new Error(`Erreur de connexion FTP: ${error.message}`);
  }
}

/**
 * Lit le fichier JSON depuis le FTP
 */
async function readLoansData() {
  const client = await createFtpClient();
  
  try {
    const chunks = [];
    
    // Créer un stream writable pour collecter les données
    const writeStream = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(chunk);
        callback();
      }
    });
    
    // Télécharger le fichier
    await client.downloadTo(writeStream, LOANS_FILE_PATH);
    
    const jsonContent = Buffer.concat(chunks).toString('utf-8');
    const data = JSON.parse(jsonContent);
    
    // Valider la structure
    if (!data.vehicles) data.vehicles = [];
    if (!data.stores) data.stores = [];
    if (!data.loans) data.loans = [];
    
    return data;
  } catch (error) {
    // Si le fichier n'existe pas, retourner la structure par défaut
    if (error.code === 550 || error.message.includes('550') || error.message.includes('not found')) {
      console.log('[FTP] Fichier non trouvé, création de la structure par défaut');
      return { ...DEFAULT_DATA };
    }
    throw new Error(`Erreur lecture FTP: ${error.message}`);
  } finally {
    client.close();
  }
}

/**
 * Écrit le fichier JSON sur le FTP
 */
async function writeLoansData(data) {
  const client = await createFtpClient();
  
  try {
    // Ajouter la date de mise à jour
    data.lastUpdate = new Date().toISOString();
    
    // Convertir en JSON avec indentation pour lisibilité
    const jsonContent = JSON.stringify(data, null, 2);
    const buffer = Buffer.from(jsonContent, 'utf-8');

    // S'assurer que le dossier existe sur le FTP
    const remoteDir = LOANS_FILE_PATH.split('/').slice(0, -1).join('/') || '/';
    await client.ensureDir(remoteDir);

    // basic-ftp n'accepte pas directement un Buffer : on le convertit en stream
    const stream = Readable.from([buffer]);
    await client.uploadFrom(stream, LOANS_FILE_PATH);
    
    return true;
  } catch (error) {
    throw new Error(`Erreur écriture FTP: ${error.message}`);
  } finally {
    client.close();
  }
}

/**
 * Liste les véhicules disponibles
 */
export async function listVehicles() {
  try {
    const data = await readLoansData();
    return {
      ok: true,
      vehicles: data.vehicles || []
    };
  } catch (error) {
    console.error('[listVehicles] Erreur:', error.message);
    return {
      ok: false,
      error: error.message,
      vehicles: []
    };
  }
}

/**
 * Met à jour un véhicule
 */
export async function updateVehicle(vehicle_id, updates) {
  try {
    const data = await readLoansData();

    const idx = (data.vehicles || []).findIndex(v => v.vehicle_id === vehicle_id);
    if (idx === -1) {
      return { ok: false, error: 'vehicle_not_found' };
    }

    const current = data.vehicles[idx];

    data.vehicles[idx] = {
      ...current,
      immatriculation: (updates.immatriculation ?? current.immatriculation ?? ''),
      marque: (updates.marque ?? current.marque ?? ''),
      modele: (updates.modele ?? current.modele ?? ''),
      magasin_home: (updates.magasin_home ?? current.magasin_home ?? ''),
      ct: (updates.ct ?? current.ct ?? ''),
      pollution: (updates.pollution ?? current.pollution ?? ''),
      disponible: (typeof updates.disponible === 'boolean') ? updates.disponible : current.disponible
    };

    await writeLoansData(data);

    return { ok: true, vehicle: data.vehicles[idx] };
  } catch (error) {
    console.error('[updateVehicle] Erreur:', error.message);
    return { ok: false, error: error.message };
  }
}


/**
 * Liste les magasins
 */
export async function listStores() {
  try {
    const data = await readLoansData();
    return {
      ok: true,
      stores: data.stores || []
    };
  } catch (error) {
    console.error('[listStores] Erreur:', error.message);
    return {
      ok: false,
      error: error.message,
      stores: []
    };
  }
}

/**
 * Recherche de prêts
 */
export async function searchLoans(immat = '', date = '') {
  try {
    const data = await readLoansData();
    let loans = data.loans || [];
    
    // Filtrer par immatriculation
    if (immat && immat.trim()) {
      const searchImmat = immat.trim().toLowerCase();
      loans = loans.filter(loan => 
        (loan.immatriculation || '').toLowerCase().includes(searchImmat)
      );
    }
    
    // Filtrer par date
    if (date && date.trim()) {
      loans = loans.filter(loan => {
        const loanDate = loan.date_depart ? loan.date_depart.split('T')[0] : '';
        return loanDate === date;
      });
    }
    
    return loans;
  } catch (error) {
    console.error('[searchLoans] Erreur:', error.message);
    return [];
  }
}

/**
 * Crée un nouveau prêt
 */
export async function createLoan(loanData) {
  try {
    const data = await readLoansData();
    
    // Générer un ID unique
    const loan_id = `LOAN_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    // Créer l'objet prêt
    const newLoan = {
      loan_id,
      vehicle_id: loanData.vehicle_id || '',
      immatriculation: loanData.immatriculation || '',
      magasin_pret: loanData.magasin_pret || '',
      chauffeur_nom: loanData.chauffeur_nom || '',
      transfert_assurance: loanData.transfert_assurance || '',
      date_depart: loanData.date_depart || '',
      heure_depart: loanData.heure_depart || '',
      date_retour: loanData.date_retour || '',
      heure_retour: loanData.heure_retour || '',
      receptionnaire_depart: loanData.receptionnaire_depart || '',
      receptionnaire_retour: loanData.receptionnaire_retour || '',
      observations: loanData.observations || '',
      status: 'en cours',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    // Ajouter le prêt
    data.loans.push(newLoan);
    
    // Sauvegarder
    await writeLoansData(data);
    
    return {
      ok: true,
      loan_id,
      loan: newLoan
    };
  } catch (error) {
    console.error('[createLoan] Erreur:', error.message);
    return {
      ok: false,
      error: error.message
    };
  }
}

/**
 * Met à jour un prêt
 */
export async function updateLoan(loanId, updates) {
  try {
    const data = await readLoansData();
    
    const loanIndex = data.loans.findIndex(l => l.loan_id === loanId);
    if (loanIndex === -1) {
      return {
        ok: false,
        error: 'Prêt non trouvé'
      };
    }
    
    const loan = data.loans[loanIndex];
    Object.keys(updates).forEach(key => {
      if (key !== 'loan_id' && key !== 'created_at') {
        loan[key] = updates[key];
      }
    });
    
    loan.updated_at = new Date().toISOString();
    
    await writeLoansData(data);
    
    return {
      ok: true,
      loan
    };
  } catch (error) {
    console.error('[updateLoan] Erreur:', error.message);
    return {
      ok: false,
      error: error.message
    };
  }
}

/**
 * Clôture un prêt
 */
export async function closeLoan(loanId, closeData) {
  try {
    const data = await readLoansData();
    
    const loanIndex = data.loans.findIndex(l => l.loan_id === loanId);
    if (loanIndex === -1) {
      return {
        ok: false,
        error: 'Prêt non trouvé'
      };
    }
    
    const loan = data.loans[loanIndex];
    
    if (loan.status && loan.status.toLowerCase().startsWith('clôt')) {
      return {
        ok: false,
        error: 'Prêt déjà clôturé'
      };
    }
    
    loan.date_retour = closeData.date_retour || '';
    loan.heure_retour = closeData.heure_retour || '';
    loan.receptionnaire_retour = closeData.receptionnaire_retour || '';
    loan.status = 'clôturé';
    loan.closed_at = new Date().toISOString();
    loan.updated_at = new Date().toISOString();
    
    await writeLoansData(data);
    
    return {
      ok: true,
      loan
    };
  } catch (error) {
    console.error('[closeLoan] Erreur:', error.message);
    return {
      ok: false,
      error: error.message
    };
  }
}

/**
 * Initialise depuis Excel
 */
export async function initializeFromExcel(excelData) {
  try {
    const data = await readLoansData();
    
    const vehiclesMap = new Map();
    const storesSet = new Set();
    
    if (excelData && Array.isArray(excelData)) {
      excelData.forEach(row => {
        if (row.vehicle_id && row.immatriculation) {
          vehiclesMap.set(row.vehicle_id, {
            vehicle_id: row.vehicle_id,
            immatriculation: row.immatriculation,
            marque: row.marque || '',
            modele: row.modele || '',
            disponible: true
          });
        }
        
        if (row.magasin) {
          storesSet.add(row.magasin);
        }
      });
    }
    
    data.vehicles = Array.from(vehiclesMap.values());
    data.stores = Array.from(storesSet).map(name => ({ name }));
    
    await writeLoansData(data);
    
    return {
      ok: true,
      vehiclesCount: data.vehicles.length,
      storesCount: data.stores.length
    };
  } catch (error) {
    console.error('[initializeFromExcel] Erreur:', error.message);
    return {
      ok: false,
      error: error.message
    };
  }
}

/**
 * Vérifie la configuration FTP
 */
export function checkFtpConfig() {
  const missing = [];
  if (!FTP_CONFIG.host) missing.push('FTP_HOST');
  if (!FTP_CONFIG.user) missing.push('FTP_USER');
  if (!FTP_CONFIG.password) missing.push('FTP_PASSWORD');
  
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Variables manquantes: ${missing.join(', ')}`
    };
  }
  
  return { ok: true };
}

// Export pour la migration
export { writeLoansData };
