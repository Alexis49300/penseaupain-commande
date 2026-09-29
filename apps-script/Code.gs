// À coller dans Extensions > Apps Script du Google Sheet.
// 1) Paramètres du projet : fuseau horaire = Europe/Paris, et Propriétés du script : SECRET = (même valeur que APPS_SECRET sur Vercel)
// 2) Exécuter setup() une fois (crée les onglets + données de démo)
// 3) Déployer > Application web (Exécuter en tant que : moi / Accès : tout le monde), copier l'URL dans APPS_SCRIPT_URL sur Vercel
const TZ = 'Europe/Paris';
const SS = SpreadsheetApp.getActive();
const S_ = String;
const H = {
  Clients: ['id', 'nom', 'contact', 'code', 'actif'],
  Produits: ['id', 'categorie', 'nom', 'prix', 'dispo'],
  Mercuriale: ['client_id', 'produit_id', 'prix'],
  Commandes: ['cle', 'client_id', 'date', 'lignes', 'maj']
};

function setup() {
  Object.keys(H).forEach(n => {
    const s = SS.getSheetByName(n) || SS.insertSheet(n);
    if (!s.getLastRow()) s.appendRow(H[n]);
    s.setFrozenRows(1);
  });
  SS.getSheetByName('Clients').getRange('A:D').setNumberFormat('@');
  SS.getSheetByName('Produits').getRange('A:C').setNumberFormat('@');
  SS.getSheetByName('Mercuriale').getRange('A:B').setNumberFormat('@');
  SS.getSheetByName('Commandes').getRange('A:D').setNumberFormat('@');
  const p = SS.getSheetByName('Produits');
  if (p.getLastRow() < 2) {
    [['P1','Pains','Baguette tradition',1.10],['P2','Pains','Pain de campagne 800 g',4.20],['P3','Pains','Pain aux céréales',3.90],
     ['P4','Viennoiseries','Croissant pur beurre',0.95],['P5','Viennoiseries','Pain au chocolat',1.05],['P6','Sandwichs','Jambon-beurre',3.10]]
      .forEach(r => p.appendRow([...r, true]));
    SS.getSheetByName('Clients').appendRow(['C1', 'Client démo', 'contact@example.fr', 'demo', true]);
    [['P1',1.10],['P4',0.95],['P5',1.05]].forEach(r => SS.getSheetByName('Mercuriale').appendRow(['C1', ...r]));
  }
}

const rows = n => {
  const v = SS.getSheetByName(n).getDataRange().getValues(), h = v.shift();
  return v.map((r, i) => Object.assign({ _r: i + 2 }, ...h.map((k, j) => ({ [k]: r[j] }))));
};
const out = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
const fmt = d => Utilities.formatDate(d, TZ, 'yyyy-MM-dd');

const A = {
  login: b => {
    const c = rows('Clients').find(c => c.actif !== false && S_(c.code).toLowerCase() === S_(b.code).trim().toLowerCase());
    if (!c) throw new Error('Code inconnu');
    return { id: S_(c.id), nom: c.nom };
  },
  catalog: b => {
    const M = rows('Mercuriale').filter(m => S_(m.client_id) === b.clientId);
    return rows('Produits').filter(p => p.dispo !== false).map(p => {
      const m = M.find(m => S_(m.produit_id) === S_(p.id));
      return m ? { pid: S_(p.id), cat: p.categorie, nom: p.nom, px: Number(m.prix) } : null;
    }).filter(Boolean);
  },
  orders: b => rows('Commandes')
    .filter(o => S_(o.date) >= b.from && (!b.clientId || S_(o.client_id) === b.clientId))
    .map(o => ({ client_id: S_(o.client_id), date: S_(o.date), lignes: JSON.parse(o.lignes) })),
  saveOrder: b => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) throw new Error('Date invalide');
    if (!b.admin) {
      const cut = new Date(b.date + 'T16:00:00'); cut.setDate(cut.getDate() - 1);
      if (b.date > fmt(new Date(Date.now() + 7 * 864e5)) || new Date() >= cut) throw new Error("Cette date n'est plus disponible à la commande");
    }
    const cat = A.catalog({ clientId: b.clientId });
    // Les prix sont toujours relus dans la mercuriale (jamais envoyés par le navigateur) puis figés dans la commande
    const lignes = Object.keys(b.lignes).map(p => {
      const c = cat.find(x => x.pid === p), q = Math.floor(Number(b.lignes[p]));
      return c && q > 0 ? { p, q, px: c.px } : null;
    }).filter(Boolean);
    const s = SS.getSheetByName('Commandes'), cle = b.clientId + '|' + b.date, ex = rows('Commandes').find(o => o.cle === cle);
    if (!lignes.length) { if (ex) s.deleteRow(ex._r); return {}; }
    const row = [cle, b.clientId, b.date, JSON.stringify(lignes), new Date()];
    ex ? s.getRange(ex._r, 1, 1, 5).setValues([row]) : s.appendRow(row);
    return {};
  },
  admin: () => {
    const M = rows('Mercuriale');
    return {
      produits: rows('Produits').map(p => ({ id: S_(p.id), cat: p.categorie, nom: p.nom, px: Number(p.prix) })),
      clients: rows('Clients').map(c => ({
        id: S_(c.id), nom: c.nom, contact: c.contact, code: S_(c.code),
        m: Object.fromEntries(M.filter(m => S_(m.client_id) === S_(c.id)).map(m => [S_(m.produit_id), Number(m.prix)]))
      }))
    };
  },
  saveClient: b => {
    const s = SS.getSheetByName('Clients'), id = b.id || 'C' + Date.now(), all = rows('Clients'), ex = all.find(c => S_(c.id) === id);
    if (all.some(c => S_(c.id) !== id && S_(c.code).toLowerCase() === S_(b.code).toLowerCase())) throw new Error('Ce code est déjà utilisé');
    const row = [id, b.nom, b.contact || '', b.code, true];
    ex ? s.getRange(ex._r, 1, 1, 5).setValues([row]) : s.appendRow(row);
    const m = SS.getSheetByName('Mercuriale');
    rows('Mercuriale').filter(r => S_(r.client_id) === id).map(r => r._r).reverse().forEach(r => m.deleteRow(r));
    Object.keys(b.m).forEach(p => m.appendRow([id, p, Number(b.m[p])]));
    return { id };
  }
};

function doPost(e) {
  const b = JSON.parse(e.postData.contents);
  if (b.secret !== PropertiesService.getScriptProperties().getProperty('SECRET')) return out({ error: 'unauthorized' });
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try { return out({ data: A[b.action](b) }); }
  catch (err) { return out({ error: err.message }); }
  finally { lock.releaseLock(); }
}
