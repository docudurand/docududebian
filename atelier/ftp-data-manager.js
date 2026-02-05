// Module pour gérer les données JSON sur le serveur FTP
import ftp from "basic-ftp";
import fs from "fs/promises";
import path from "path";

class FTPDataManager {
  constructor() {
    this.config = {
      host: process.env.FTP_HOST || "",
      port: parseInt(process.env.FTP_PORT || "21"),
      user: process.env.FTP_USER || "",
      password: process.env.FTP_PASS || process.env.FTP_PASSWORD || "",
      secure: process.env.FTP_SECURE === "true",
      tlsInsecure: process.env.FTP_TLS_INSECURE === "1",
      tlsRejectUnauth: process.env.FTP_TLS_REJECT_UNAUTH !== "0"
    };
    this.backupFolder = process.env.FTP_BACKUP_FOLDER || "/Disque 1/service";
    this.dataFile = "atelier_data.json";
    this.localCache = null;
    this.lastFetch = null;
    this.cacheDuration = 60000;
  }

  async connect() {
    const client = new ftp.Client();
    client.ftp.verbose = false;
    
    try {
      await client.access({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        secure: this.config.secure,
        secureOptions: {
          rejectUnauthorized: this.config.tlsRejectUnauth
        }
      });
      return client;
    } catch (error) {
      console.error("Erreur de connexion FTP:", error);
      throw error;
    }
  }

  async downloadData() {
    const client = await this.connect();
    
    try {
      const remotePath = path.posix.join(this.backupFolder, this.dataFile);
      const localPath = path.join("/tmp", this.dataFile);
      
      await client.downloadTo(localPath, remotePath);
      
      const content = await fs.readFile(localPath, "utf-8");
      const data = JSON.parse(content);
      
      // Mettre en cache
      this.localCache = data;
      this.lastFetch = Date.now();
      
      return data;
    } catch (error) {
      console.error("Erreur de téléchargement:", error);
      throw error;
    } finally {
      client.close();
    }
  }

  async uploadData(data) {
    const client = await this.connect();
    
    try {
      // Sauvegarder localement d'abord
      const localPath = path.join("/tmp", this.dataFile);
      await fs.writeFile(localPath, JSON.stringify(data, null, 2), "utf-8");
      
      // Upload vers FTP
      const remotePath = path.posix.join(this.backupFolder, this.dataFile);
      await client.uploadFrom(localPath, remotePath);
      
      // Mettre à jour le cache
      this.localCache = data;
      this.lastFetch = Date.now();
      
      return true;
    } catch (error) {
      console.error("Erreur d'upload:", error);
      throw error;
    } finally {
      client.close();
    }
  }

  async getData(useCache = true) {
    // Utiliser le cache si disponible et récent
    if (useCache && this.localCache && this.lastFetch) {
      const age = Date.now() - this.lastFetch;
      if (age < this.cacheDuration) {
        return this.localCache;
      }
    }
    
    return await this.downloadData();
  }

  async updateCase(caseNo, updates) {
    const data = await this.getData(false);
    
    // Trouver et mettre à jour le dossier
    const caseIndex = data.atelier.findIndex(c => 
      String(c.no) === String(caseNo)
    );
    
    if (caseIndex === -1) {
      throw new Error(`Dossier ${caseNo} introuvable`);
    }
    
    // Appliquer les mises à jour
    data.atelier[caseIndex] = {
      ...data.atelier[caseIndex],
      ...updates,
      dateStatus: new Date().toISOString()
    };
    
    // Mettre à jour les métadonnées
    data._metadata.lastUpdate = new Date().toISOString();
    
    // Upload les données mises à jour
    await this.uploadData(data);
    
    return data.atelier[caseIndex];
  }

  async addCase(caseData) {
    const data = await this.getData(false);
    
    // Générer un nouveau numéro de dossier
    const maxNo = Math.max(...data.atelier.map(c => c.no || 0), 0);
    const newCase = {
      no: maxNo + 1,
      date: new Date().toISOString(),
      dateStatus: new Date().toISOString(),
      ...caseData
    };
    
    data.atelier.push(newCase);
    data._metadata.lastUpdate = new Date().toISOString();
    data._metadata.totalDossiers = data.atelier.length;
    
    await this.uploadData(data);
    
    return newCase;
  }

  async getCaseByNo(caseNo) {
    const data = await this.getData();
    const caseItem = data.atelier.find(c => 
      String(c.no) === String(caseNo)
    );
    
    if (!caseItem) {
      throw new Error(`Dossier ${caseNo} introuvable`);
    }
    
    return caseItem;
  }

  async getAllCases(filters = {}) {
    const data = await this.getData();
    let cases = data.atelier;
    
    // Appliquer les filtres
    if (filters.status) {
      cases = cases.filter(c => c.status === filters.status);
    }
    if (filters.magasin) {
      cases = cases.filter(c => c.magasin === filters.magasin);
    }
    if (filters.service) {
      cases = cases.filter(c => c.service === filters.service);
    }
    
    return cases;
  }

  async getLignes() {
    const data = await this.getData();
    return data.lignes.filter(l => l.actif);
  }

  async getReglesRef(filters = {}) {
    const data = await this.getData();
    let regles = data.regles_ref.filter(r => r.actif);
    
    if (filters.service) {
      regles = regles.filter(r => r.service === filters.service);
    }
    if (filters.cylindres) {
      regles = regles.filter(r => r.cylindres === filters.cylindres);
    }
    if (filters.carburant) {
      regles = regles.filter(r => r.carburant === filters.carburant);
    }
    
    return regles;
  }

  clearCache() {
    this.localCache = null;
    this.lastFetch = null;
  }
}

export default FTPDataManager;
