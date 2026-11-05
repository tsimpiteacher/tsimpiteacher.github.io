/* Συγχρονισμός της σουίτας ανάμεσα σε συσκευές (Google / Firebase).
 *
 * Ασφαλής κανόνας: τίποτα δεν αντικαθίσταται χωρίς να το ξέρεις.
 *  - Ό,τι αλλάζεις σε αυτή τη συσκευή στέλνεται μόνο του στο cloud, εφόσον το cloud δεν έχει κάτι νεότερο από άλλη συσκευή.
 *  - Αν το cloud έχει νεότερη δουλειά από άλλη συσκευή, εμφανίζεται μήνυμα που μένει μέχρι να διαλέξεις:
 *    «Συνέχεια από εκεί» ή «Κράτα αυτή τη συσκευή».
 *  - Πριν από κάθε τέτοια επιλογή κρατιέται αντίγραφο της δουλειάς που αντικαθίσταται → «Αναίρεση».
 *  - Κάθε συσκευή έχει όνομα (π.χ. «Σχολείο», «Σπίτι»), για να ξέρεις από πού ήρθε κάθε αλλαγή.
 *
 * Τα δεδομένα χωρίζονται σε ομάδες (μία ανά εφαρμογή + το κοινό πρόγραμμα), καθεμία σε δικό της έγγραφο:
 *   users/{uid}/gr/suite-{ομάδα} = { at, deviceId, device, data: { κλειδί localStorage: τιμή } }
 */
(function () {
  'use strict';
  if (window.SUITE_SYNC) return;
  var GROUPS = {
    sy: { name: 'Συμπύκνωση', keys: ['sym-draft-v1', 'sym-base-v1'] },
    tt: { name: 'Ωρολόγιο πρόγραμμα', keys: ['suite-timetable-v1'] },
    ef: { name: 'Εφημερίες', keys: ['efimeries-session-local-v1', 'efimeries-settings-v1', 'efimeries-settings-at-v1', 'efimeries-history-v1', 'efimeries-hist-tomb-v1', 'suite-dl-ef', 'suite-tt-used-ef'] },
    gr: { name: 'ΓΡ', keys: ['gr-plan-v1', 'gr-settings-v1', 'gr-history-v1', 'gr-saved-at', 'suite-tt-used-gr'] },
    an: { name: 'Αναπληρώσεις', keys: ['anapl-history-v1', 'anapl-draft-v1', 'suite-an-saved'] }
  };
  var ORDER = ['sy', 'tt', 'ef', 'gr', 'an'];
  // ποιες ομάδες «ανήκουν» σε κάθε σελίδα (για το μήνυμα νεότερων αλλαγών)
  var path = location.pathname;
  var APP = /\/sympyknosi\//.test(path) ? 'sy' : /\/efimeries\//.test(path) ? 'ef' : /\/gr\//.test(path) ? 'gr' : /\/anaplirwseis\//.test(path) ? 'an' : 'hub';
  var MINE = { sy: ['sy', 'tt'], ef: ['ef', 'tt'], gr: ['gr', 'tt'], an: ['an'], hub: ORDER }[APP];
  var META_K = 'suite-sync-meta', DEV_K = 'suite-device', BACKUP_K = 'suite-sync-backup', CLOUD_K = 'suite-sync-cloud', PEND_K = 'suite-sync-pending';
  var FB_CFG = { apiKey: 'AIzaSyCAdFnxdD4iFyBGLuSybAyUPOT9B0c4w-Q', authDomain: 'gr-sxoleio.firebaseapp.com', projectId: 'gr-sxoleio',
    storageBucket: 'gr-sxoleio.firebasestorage.app', messagingSenderId: '388278338092', appId: '1:388278338092:web:4678ddab40e6bbacd00789' };

  /* ---------- βοηθητικά ---------- */
  function jget(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function when(t) {
    if (!t) return '—'; var d = new Date(t), p = function (n) { return (n < 10 ? '0' : '') + n; };
    var today = new Date(), y = new Date(); y.setDate(today.getDate() - 1);
    var DN = ['Κυρ', 'Δευ', 'Τρί', 'Τετ', 'Πέμ', 'Παρ', 'Σάβ'];
    var day = d.toDateString() === today.toDateString() ? 'σήμερα' : d.toDateString() === y.toDateString() ? 'χθες' : DN[d.getDay()] + ' ' + p(d.getDate()) + '/' + p(d.getMonth() + 1);
    return day + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function readLocal(g) { var o = {}; GROUPS[g].keys.forEach(function (k) { var v = null; try { v = localStorage.getItem(k); } catch (e) {} o[k] = v; }); return o; }
  function writeLocal(g, data) { GROUPS[g].keys.forEach(function (k) { var v = data ? data[k] : null; try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }); }
  // Πεδία που αλλάζουν σε κάθε αποθήκευση χωρίς να αλλάζει η δουλειά (ώρα αποθήκευσης, επιλεγμένη καρτέλα):
  // δεν μετράνε ως «αλλαγή», ώστε ένα απλό άνοιγμα να μη στέλνει τίποτα και να μη βγάζει μήνυμα στην άλλη συσκευή.
  var VOLATILE = { 'sym-draft-v1': ['at', 'view', 'day'], '*': ['at'] }, normCache = {};
  function norm(k, v) {
    if (v == null || v.charAt(0) !== '{') return v;
    var c = normCache[k]; if (c && c.raw === v) return c.out;
    var out = v;
    try { var o = JSON.parse(v); (VOLATILE[k] || VOLATILE['*']).forEach(function (f) { delete o[f]; }); out = JSON.stringify(o); } catch (e) {}
    normCache[k] = { raw: v, out: out }; return out;
  }
  function hashOf(data) {   // FNV-1a πάνω στις τιμές της ομάδας
    var h = 0x811c9dc5, s = JSON.stringify(Object.keys(data).sort().map(function (k) { return [k, norm(k, data[k])]; }));
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16) + ':' + s.length;
  }
  function isEmpty(data) { return Object.keys(data).every(function (k) { return data[k] == null; }); }
  function meta() { return jget(META_K) || {}; }
  function setMeta(g, patch) { var m = meta(); m[g] = Object.assign({}, m[g] || {}, patch); jset(META_K, m); }
  // Εφαρμογή αλλαγών που ζητήθηκαν πριν από την επαναφόρτωση: γίνεται εδώ, πριν τρέξει ο κώδικας της εφαρμογής,
  // ώστε καμία αποθήκευση της προηγούμενης σελίδας (π.χ. στο κλείσιμο) να μην τις χαλάσει.
  (function applyPending() {
    var p = null; try { p = JSON.parse(sessionStorage.getItem(PEND_K)); sessionStorage.removeItem(PEND_K); } catch (e) {}
    if (!p || !p.groups) return;
    Object.keys(p.groups).forEach(function (g) {
      if (!GROUPS[g]) return; writeLocal(g, p.groups[g]);
      var h = hashOf(readLocal(g)), x = { lastSeen: h, localAt: p.at || Date.now() };
      if (p.synced && p.synced[g]) { x.syncedAt = p.synced[g]; x.hash = h; }
      setMeta(g, x);
    });
    if (p.msg) try { sessionStorage.setItem('suite-sync-msg', p.msg); } catch (e) {}
  })();
  function applyAndReload(groups, synced, msg) {
    try { sessionStorage.setItem(PEND_K, JSON.stringify({ groups: groups, synced: synced, msg: msg, at: Date.now() })); }
    catch (e) { Object.keys(groups).forEach(function (g) { writeLocal(g, groups[g]); }); }
    location.reload();
  }
  function device() {
    var d = jget(DEV_K);
    if (!d || !d.id) { d = { id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), name: '' }; jset(DEV_K, d); }
    return d;
  }

  /* ---------- αποθήκη: Firebase (ή ψεύτικη για δοκιμές: window.__SUITE_FAKE) ---------- */
  var backend = window.__SUITE_FAKE ? window.__SUITE_FAKE : (function () {
    var auth = null, db = null, uid = null;
    function load(src) { return new Promise(function (ok, no) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
    function ref(g) { return db.collection('users').doc(uid).collection('gr').doc('suite-' + g); }
    return {
      init: function (onAuth) {
        var base = 'https://www.gstatic.com/firebasejs/10.12.2/';
        return (window.firebase && firebase.firestore ? Promise.resolve() : load(base + 'firebase-app-compat.js').then(function () { return Promise.all([load(base + 'firebase-auth-compat.js'), load(base + 'firebase-firestore-compat.js')]); }))
          .then(function () {
            if (!firebase.apps.length) firebase.initializeApp(FB_CFG);
            auth = firebase.auth(); db = firebase.firestore();
            auth.onAuthStateChanged(function (u) { uid = u ? u.uid : null; onAuth(u ? { email: u.email || '' } : null); });
          });
      },
      signIn: function () {
        var prov = new firebase.auth.GoogleAuthProvider();
        return auth.signInWithPopup(prov).catch(function (e) { if (/popup|operation-not-supported|cancelled-popup/.test(e.code || '')) return auth.signInWithRedirect(prov); throw e; });
      },
      signOut: function () { return auth.signOut(); },
      get: function (g) { return ref(g).get().then(function (s) { return s.exists ? s.data() : null; }); },
      watch: function (g, cb) { return ref(g).onSnapshot(function (s) { if (!s.metadata.hasPendingWrites) cb(s.exists ? s.data() : null); }, function () {}); },
      // γράφει μόνο αν το cloud δεν έχει κάτι νεότερο από άλλη συσκευή (εκτός αν force)
      write: function (g, doc, expectAt, force) {
        var r = ref(g);
        return db.runTransaction(function (tx) {
          return tx.get(r).then(function (s) {
            var cur = s.exists ? s.data() : null;
            if (!force && cur && (cur.at || 0) > (expectAt || 0) && cur.deviceId !== doc.deviceId) return { conflict: cur };
            tx.set(r, doc); return { ok: true };
          });
        });
      }
    };
  })();

  /* ---------- κατάσταση ---------- */
  var S = { ready: false, user: null, err: '', busy: 0, remote: {}, pending: {}, unsubs: [], shown: false };
  window.SUITE_SYNC = { groups: GROUPS, app: APP, open: function () { openPanel(); }, state: S, status: status };
  function status() {
    var m = meta(), out = {};
    ORDER.forEach(function (g) { var r = S.remote[g]; out[g] = { name: GROUPS[g].name, localAt: (m[g] || {}).localAt || 0, cloudAt: r ? r.at || 0 : 0, cloudDevice: r ? r.device || '' : '', newer: isNewer(g), dirty: isDirty(g) }; });
    return out;
  }
  function isDirty(g) { var m = meta()[g]; return !m || m.hash !== hashOf(readLocal(g)); }
  function isNewer(g) {   // το cloud έχει κάτι που δεν έχουμε δει, από άλλη συσκευή
    var r = S.remote[g], m = meta()[g] || {};
    return !!(r && r.deviceId !== device().id && (r.at || 0) > (m.syncedAt || 0) && hashOf(r.data || {}) !== hashOf(readLocal(g)));
  }
  function emit() {
    var st = status(); jset(CLOUD_K, Object.keys(st).reduce(function (o, g) { o[g] = { at: st[g].cloudAt, device: st[g].cloudDevice }; return o; }, {}));
    try { window.dispatchEvent(new CustomEvent('suite-sync', { detail: st })); } catch (e) {}
    renderBtn(); renderBanner();
  }

  /* ---------- αποστολή τοπικών αλλαγών ---------- */
  function push(g, force) {
    if (!S.user) return Promise.resolve(false);
    var data = readLocal(g), h = hashOf(data), m = meta()[g] || {};
    if (!force && m.hash === h && m.syncedAt) return Promise.resolve(true);
    if (!force && isEmpty(data) && !m.syncedAt) { setMeta(g, { hash: h }); return Promise.resolve(true); }
    var size = JSON.stringify(data).length;
    if (size > 950000) { S.err = 'Τα δεδομένα «' + GROUPS[g].name + '» είναι πολύ μεγάλα για συγχρονισμό.'; emit(); return Promise.resolve(false); }
    var dev = device(), doc = { at: Date.now(), deviceId: dev.id, device: dev.name || 'Συσκευή', data: data };
    S.busy++; renderBtn();
    return backend.write(g, doc, m.syncedAt || 0, !!force).then(function (res) {
      if (res && res.conflict) { S.remote[g] = res.conflict; return false; }
      S.remote[g] = doc; setMeta(g, { syncedAt: doc.at, hash: h, localAt: m.localAt || doc.at }); S.err = ''; return true;
    }).catch(function (e) {
      S.err = e && e.code === 'permission-denied' ? 'Ο λογαριασμός δεν επιτρέπει τον συγχρονισμό (κανόνες Firestore).' : 'Δεν έγινε συγχρονισμός (χωρίς σύνδεση;) — θα ξαναδοκιμάσει.';
      return false;
    }).then(function (ok) { S.busy--; emit(); return ok; });
  }
  // έλεγχος για τοπικές αλλαγές: κάθε λίγα δευτερόλεπτα και όταν αλλάζει κάτι σε άλλη καρτέλα
  var timers = {};
  function tick() {
    ORDER.forEach(function (g) {
      var m = meta()[g] || {}, h = hashOf(readLocal(g));
      if (m.lastSeen !== h) { setMeta(g, { lastSeen: h, localAt: m.lastSeen ? Date.now() : (m.localAt || 0) }); }
      if (!S.user || !S.ready) return;
      if (isNewer(g)) return;                       // πρώτα πρέπει να διαλέξεις (μήνυμα)
      if (m.hash !== h || !m.syncedAt) { clearTimeout(timers[g]); timers[g] = setTimeout(function () { push(g); }, 1500); }
    });
    renderBtn();
  }

  /* ---------- νεότερες αλλαγές από άλλη συσκευή ---------- */
  function onRemote(g, doc) {
    S.remote[g] = doc;
    var m = meta()[g] || {}, local = readLocal(g);
    if (doc && doc.deviceId === device().id) { if ((doc.at || 0) >= (m.syncedAt || 0) && hashOf(doc.data || {}) === hashOf(local)) setMeta(g, { syncedAt: doc.at, hash: hashOf(local) }); }
    else if (doc && hashOf(doc.data || {}) === hashOf(local)) setMeta(g, { syncedAt: doc.at, hash: hashOf(local) });   // ίδιο περιεχόμενο
    else if (doc && !m.syncedAt && isEmpty(local)) {     // καινούργια συσκευή χωρίς δική της δουλειά: παίρνει από το cloud
      var one = {}, syn = {}; one[g] = doc.data; syn[g] = doc.at;
      if (MINE.indexOf(g) >= 0) { emptyQ.groups[g] = doc.data; emptyQ.synced[g] = doc.at; emptyQ.from = doc.device; clearTimeout(emptyQ.t); emptyQ.t = setTimeout(flushEmpty, 400); }
      else { writeLocal(g, doc.data); var hh = hashOf(readLocal(g)); setMeta(g, { syncedAt: doc.at, hash: hh, lastSeen: hh }); }
    }
    else if (!doc) { /* τίποτα στο cloud: θα σταλεί η τοπική */ }
    emit();
  }
  var emptyQ = { groups: {}, synced: {}, t: 0, from: '' };
  function flushEmpty() { applyAndReload(emptyQ.groups, emptyQ.synced, 'Φορτώθηκε η δουλειά από ' + (emptyQ.from || 'άλλη συσκευή') + '.'); }
  function backup(label, groups, source) {
    var b = { at: Date.now(), label: label, groups: {} };
    groups.forEach(function (g) { b.groups[g] = source === 'remote' ? (S.remote[g] && S.remote[g].data) || {} : readLocal(g); });
    jset(BACKUP_K, b);
  }
  function takeRemote(groups) {
    var from = (S.remote[groups[0]] || {}).device || 'άλλη συσκευή';
    backup('πριν πάρεις τις αλλαγές από ' + from, groups, 'local');
    var data = {}, syn = {};
    groups.forEach(function (g) { var d = S.remote[g]; if (!d) return; data[g] = d.data; syn[g] = d.at; });
    applyAndReload(data, syn, 'Συνέχεια από ' + from + ' · κρατήθηκε αντίγραφο της προηγούμενης δουλειάς.');
  }
  function keepLocal(groups) {
    var from = (S.remote[groups[0]] || {}).device || 'άλλη συσκευή';
    backup('οι αλλαγές από ' + from + ' που δεν κράτησες', groups, 'remote');
    Promise.all(groups.map(function (g) { return push(g, true); })).then(function () { flash('Κρατήθηκε η δουλειά αυτής της συσκευής και στάλθηκε στο cloud.'); emit(); });
  }
  function undo() {
    var b = jget(BACKUP_K); if (!b) return;
    if (!confirm('Επαναφορά: ' + b.label + ' (' + when(b.at) + ');')) return;
    var cur = { at: Date.now(), label: 'πριν από την αναίρεση', groups: {} };
    Object.keys(b.groups).forEach(function (g) { cur.groups[g] = readLocal(g); });
    jset(BACKUP_K, cur);   // ώστε να γίνεται και αναίρεση της αναίρεσης
    applyAndReload(b.groups, null, 'Έγινε επαναφορά · θα σταλεί στο cloud.');
  }

  /* ---------- εμφάνιση: κουμπί στην μπάρα, μήνυμα, πίνακας ---------- */
  var css = document.createElement('style');
  css.textContent = [
    '.ssync-btn{display:inline-flex;align-items:center;gap:5px;height:36px;padding:0 10px;border:0;border-radius:10px;background:transparent;font:600 12.5px/1 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:inherit;cursor:pointer;white-space:nowrap;opacity:.85}',
    '.ssync-btn:hover{background:rgba(127,127,127,.14);opacity:1}',
    '.ssync-btn.on{color:#2E7D4F}.ssync-btn.warn{background:#F2B233;color:#2A1D00;opacity:1}.ssync-btn.err{color:#C62828}',
    '@media (max-width:760px){.ssync-btn .t{display:none}}',
    '.ssync-ban{position:sticky;top:0;z-index:60;max-width:1240px;margin:0 auto 14px;padding:12px 14px;border-radius:12px;background:#FFF4D6;color:#3A2A00;border:1px solid #F2B233;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.12)}',
    '.ssync-ban.info{background:#E3F2E8;border-color:#7BC496;color:#163A22}',
    '.ssync-ban .tx{flex:1 1 300px}.ssync-ban b{font-weight:700}',
    '.ssync-ban button{font:600 13.5px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:8px 12px;border-radius:9px;border:1px solid rgba(0,0,0,.2);background:#fff;color:#1D2433;cursor:pointer}',
    '.ssync-ban button.p{background:#1D2433;color:#fff;border-color:#1D2433}',
    '.ssync-pan{position:fixed;z-index:70;top:64px;right:16px;width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 90px);overflow:auto;background:#fff;color:#1D2433;border:1px solid rgba(0,0,0,.15);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);padding:16px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}',
    '.ssync-pan h3{margin:0 0 8px;font-size:16px}.ssync-pan .sub{color:#5A6577;font-size:13px;margin:0 0 10px}',
    '.ssync-pan table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}.ssync-pan td,.ssync-pan th{padding:6px 4px;border-bottom:1px solid #E5E9F0;text-align:left;vertical-align:top}.ssync-pan th{color:#5A6577;font-weight:600}',
    '.ssync-pan .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}',
    '.ssync-pan button{font:600 13px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:7px 11px;border-radius:9px;border:1px solid #C9D1DE;background:#fff;color:#1D2433;cursor:pointer}',
    '.ssync-pan button.p{background:#1D2433;color:#fff;border-color:#1D2433}',
    '.ssync-pan input{font:inherit;padding:6px 8px;border:1px solid #C9D1DE;border-radius:8px;min-width:0;flex:1}',
    '.ssync-pan .new{color:#A85D00;font-weight:700}.ssync-pan .ok{color:#2E7D4F}',
    '.ssync-pan .x{position:absolute;top:8px;right:10px;border:0;background:transparent;font-size:20px;padding:4px 8px}',
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .ssync-pan{background:#1B2338;color:#E8EDF5;border-color:#33405F}:root:not([data-theme="light"]) .ssync-pan td,:root:not([data-theme="light"]) .ssync-pan th{border-color:#33405F}:root:not([data-theme="light"]) .ssync-pan button,:root:not([data-theme="light"]) .ssync-pan input{background:#232C45;color:#E8EDF5;border-color:#3B4A6E}}',
    ':root[data-theme="dark"] .ssync-pan{background:#1B2338;color:#E8EDF5;border-color:#33405F}:root[data-theme="dark"] .ssync-pan td,:root[data-theme="dark"] .ssync-pan th{border-color:#33405F}:root[data-theme="dark"] .ssync-pan button,:root[data-theme="dark"] .ssync-pan input{background:#232C45;color:#E8EDF5;border-color:#3B4A6E}',
    '@media print{.ssync-btn,.ssync-ban,.ssync-pan{display:none!important}}'
  ].join('\n');
  document.head.appendChild(css);

  var btn = null, ban = null, pan = null;
  function mount() {
    btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ssync-btn'; btn.id = 'suiteSyncBtn';
    btn.addEventListener('click', function () { pan && !pan.hidden ? closePanel() : openPanel(); });
    var host = document.querySelector('#suiteBar .sbar-right'), theme = document.getElementById('sbarTheme');
    if (host) host.insertBefore(btn, theme || host.firstChild);
    else { var tb = document.querySelector('.topbar'), th = document.getElementById('themeBtn'); if (tb) tb.insertBefore(btn, th && th.parentNode === tb ? th : tb.firstChild); else document.body.insertBefore(btn, document.body.firstChild); }
    ban = document.createElement('div'); ban.className = 'ssync-ban'; ban.id = 'suiteSyncBanner'; ban.hidden = true;
    var bar = document.getElementById('suiteBar');
    if (bar && bar.parentNode) bar.parentNode.insertBefore(ban, bar.nextSibling);
    else { var w = document.querySelector('.wrap') || document.body; w.insertBefore(ban, w.firstChild); }
    ban.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ss]'); if (!b) return;
      var a = b.getAttribute('data-ss'), gs = newerMine();
      if (a === 'take') takeRemote(gs); else if (a === 'keep') keepLocal(gs); else if (a === 'undo') undo(); else if (a === 'x') { ban.hidden = true; ban.dataset.dismissed = '1'; } else if (a === 'login') signIn(); else if (a === 'name') askName();
    });
    var msg = sessionStorage.getItem('suite-sync-msg');
    if (msg) { sessionStorage.removeItem('suite-sync-msg'); flash(msg, true); }
    renderBtn();
  }
  var flashT = 0, flashMsg = '', flashUndo = false;
  function flash(m, withUndo) { flashMsg = m; flashUndo = !!withUndo; clearTimeout(flashT); flashT = setTimeout(function () { flashMsg = ''; renderBanner(); }, 15000); renderBanner(); }
  function newerMine() { return MINE.filter(isNewer); }
  function renderBtn() {
    if (!btn) return;
    var cls = '', t = '', tip = '';
    if (!S.ready) { t = 'Συγχρονισμός…'; tip = 'Φόρτωση συγχρονισμού'; }
    else if (!S.user) { t = 'Σύνδεση'; tip = 'Σύνδεση με Google για ίδια δουλειά σε όλες τις συσκευές'; }
    else if (ORDER.some(isNewer)) { cls = 'warn'; t = 'Νέες αλλαγές'; tip = 'Υπάρχουν νεότερες αλλαγές από άλλη συσκευή'; }
    else if (S.err) { cls = 'err'; t = 'Πρόβλημα'; tip = S.err; }
    else if (S.busy || ORDER.some(function (g) { var m = meta()[g] || {}; return m.lastSeen && m.hash !== m.lastSeen; })) { cls = 'on'; t = 'Αποστολή…'; tip = 'Στέλνονται οι αλλαγές σου'; }
    else { cls = 'on'; var last = Math.max.apply(null, ORDER.map(function (g) { return (meta()[g] || {}).syncedAt || 0; })); t = 'Συγχρονισμένο' + (last ? ' · ' + when(last).replace(/^σήμερα /, '') : ''); tip = 'Όλα συγχρονισμένα · ' + (device().name || ''); }
    btn.className = 'ssync-btn ' + cls; btn.title = tip + ' · πάτα για λεπτομέρειες';
    btn.innerHTML = '<span aria-hidden="true">' + (cls === 'warn' || cls === 'err' ? '⚠' : '☁') + '</span><span class="t">' + esc(t) + '</span>';
  }
  function renderBanner() {
    if (!ban) return;
    var gs = S.user ? newerMine() : [];
    if (gs.length) {
      var r = S.remote[gs[0]] || {}, dirty = gs.some(isDirty), lat = Math.max.apply(null, gs.map(function (g) { return (meta()[g] || {}).localAt || 0; }));
      var names = gs.map(function (g) { return GROUPS[g].name; }).join(', ');
      ban.className = 'ssync-ban';
      ban.innerHTML = '<span class="tx">⚠ Νεότερες αλλαγές από <b>' + esc(r.device || 'άλλη συσκευή') + '</b> (' + when(r.at) + ') σε: <b>' + esc(names) + '</b>.' +
        (dirty ? '<br>Και <b>εδώ</b> υπάρχουν αλλαγές που δεν έχουν σταλεί (' + when(lat) + '). Διάλεξε ποια δουλειά κρατάς — η άλλη μένει ως αντίγραφο.' : '<br>Πάρε τες για να συνεχίσεις από εκεί που έμεινες.') + '</span>' +
        '<button type="button" class="p" data-ss="take">Συνέχεια από ' + esc(r.device || 'εκεί') + '</button><button type="button" data-ss="keep">Κράτα αυτή τη συσκευή</button>';
      ban.hidden = false; return;
    }
    if (flashMsg) { ban.className = 'ssync-ban info'; ban.innerHTML = '<span class="tx">✓ ' + esc(flashMsg) + '</span>' + (flashUndo && jget(BACKUP_K) ? '<button type="button" data-ss="undo">Αναίρεση</button>' : '') + '<button type="button" data-ss="x" aria-label="Κλείσιμο">×</button>'; ban.hidden = false; return; }
    if (S.user && !device().name && !ban.dataset.dismissed) { ban.className = 'ssync-ban info'; ban.innerHTML = '<span class="tx">Δώσε ένα όνομα σε αυτή τη συσκευή (π.χ. «Σχολείο», «Σπίτι»), για να ξέρεις από πού ήρθε κάθε αλλαγή.</span><button type="button" class="p" data-ss="name">Όνομα συσκευής</button><button type="button" data-ss="x" aria-label="Κλείσιμο">×</button>'; ban.hidden = false; return; }
    ban.hidden = true;
  }
  function askName() {
    var d = device(), n = prompt('Όνομα για αυτή τη συσκευή (π.χ. Σχολείο, Σπίτι, Laptop):', d.name || '');
    if (n == null) return; n = n.trim().slice(0, 30); if (!n) return;
    d.name = n; jset(DEV_K, d); flash('Η συσκευή λέγεται «' + n + '».'); if (pan && !pan.hidden) openPanel(); emit();
  }
  function signIn() { backend.signIn().catch(function (e) { S.err = 'Η σύνδεση απέτυχε: ' + (e && (e.message || e.code) || e); emit(); }); }
  function closePanel() { if (pan) pan.hidden = true; }
  function openPanel() {
    if (!pan) {
      pan = document.createElement('div'); pan.className = 'ssync-pan'; pan.id = 'suiteSyncPanel'; document.body.appendChild(pan);
      pan.addEventListener('click', function (e) {
        var b = e.target.closest('[data-sp]'); if (!b) return; var a = b.getAttribute('data-sp');
        if (a === 'x') closePanel(); else if (a === 'login') signIn(); else if (a === 'name') askName(); else if (a === 'undo') undo();
        else if (a === 'logout') { if (confirm('Αποσύνδεση; Η δουλειά μένει σε αυτή τη συσκευή, αλλά δεν θα συγχρονίζεται.')) backend.signOut(); }
        else if (a === 'now') { ORDER.forEach(function (g) { if (!isNewer(g)) push(g); }); flash('Έγινε έλεγχος και αποστολή.'); }
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePanel(); });
    }
    var d = device(), st = status(), b = jget(BACKUP_K);
    var h = '<button type="button" class="x" data-sp="x" aria-label="Κλείσιμο">×</button><h3>Συγχρονισμός συσκευών</h3>';
    if (!S.user) {
      h += '<p class="sub">Με σύνδεση Google, η ίδια δουλειά (Συμπύκνωση, Εφημερίες, ΓΡ, Αναπληρώσεις) φαίνεται σε όλες τις συσκευές σου. Τίποτα δεν αντικαθίσταται χωρίς να σε ρωτήσει.</p><div class="row"><button type="button" class="p" data-sp="login">Σύνδεση με Google</button></div>';
    } else {
      h += '<p class="sub">Λογαριασμός: <b>' + esc(S.user.email) + '</b></p>';
      h += '<div class="row">Αυτή η συσκευή: <b>' + esc(d.name || '(χωρίς όνομα)') + '</b> <button type="button" data-sp="name">Αλλαγή ονόματος</button></div>';
      h += '<table><tr><th>Εφαρμογή</th><th>Εδώ</th><th>Cloud</th></tr>' + ORDER.map(function (g) {
        var x = st[g];
        return '<tr><td>' + esc(x.name) + '</td><td>' + (x.localAt ? when(x.localAt) : '—') + (x.dirty ? ' <span class="new">· δεν έχει σταλεί</span>' : '') + '</td><td>' +
          (x.cloudAt ? esc(x.cloudDevice) + ' · ' + when(x.cloudAt) : '—') + (x.newer ? ' <span class="new">· νεότερο</span>' : x.cloudAt && !x.dirty ? ' <span class="ok">✓</span>' : '') + '</td></tr>';
      }).join('') + '</table>';
      if (S.err) h += '<p class="new">' + esc(S.err) + '</p>';
      h += '<div class="row"><button type="button" data-sp="now">Συγχρονισμός τώρα</button>' + (b ? '<button type="button" data-sp="undo" title="' + esc(b.label) + '">Αναίρεση: ' + esc(b.label) + ' (' + when(b.at) + ')</button>' : '') + '</div>';
      h += '<div class="row"><button type="button" data-sp="logout">Αποσύνδεση</button></div>';
    }
    pan.innerHTML = h; pan.hidden = false;
  }

  /* ---------- εκκίνηση ---------- */
  function start() {
    mount();
    tick();
    setInterval(tick, 2500);
    window.addEventListener('storage', function (e) { if (e.key && ORDER.some(function (g) { return GROUPS[g].keys.indexOf(e.key) >= 0; })) tick(); });
    if (!location.protocol.startsWith('http')) { S.ready = true; renderBtn(); return; }
    Promise.resolve(backend.init(function (u) {
      S.ready = true; S.user = u; S.err = '';
      S.unsubs.forEach(function (f) { try { f(); } catch (e) {} }); S.unsubs = []; S.remote = {};
      if (u) ORDER.forEach(function (g) { S.unsubs.push(backend.watch(g, function (doc) { onRemote(g, doc); })); });
      emit(); tick();
    })).catch(function () { S.ready = true; S.err = 'Δεν φορτώθηκε ο συγχρονισμός (χωρίς internet;).'; emit(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
