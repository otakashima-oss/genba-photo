/* 現場写真：画面の動き
   1. 現場名を入れる（前に使った現場名は候補に出る）
   2. 写真を撮る（またはアルバムから選ぶ）→ 長い辺 1600px の JPEG に縮める。撮影日時は写真の情報（EXIF）から読む
   3. 「話す」でコメントを文字にする（使えない機種はキーボードのマイク）
   4. 「この写真を送る」：写真を本人の Google ドライブの「現場写真（アプリ）」フォルダに保存する（Drive API、drive.file）
      現場名・撮影者・撮影日時・コメントは、ファイルの説明（description）に JSON で入れる
      電波がないときは携帯（IndexedDB）に保存し、電波が戻ったら送る
   事務所の画面（office.html）が、ドライブから指定のフォルダに取り込み、報告書を作る。
   設定（config.js）：window.GOOGLE_CLIENT_ID */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var MAX_SEC = 90, MAX_PX = 1600, QUALITY = 0.82;
  var DRIVE = 'https://www.googleapis.com/auth/drive.file'; // このアプリが作ったファイルだけを扱える許可
  var SCOPE = DRIVE + ' email';
  var FOLDER = '現場写真（アプリ）';
  var store = {
    get: function (k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  // ---------- お知らせ ----------
  var msgTimer = null;
  function show(text, kind) {
    var m = $('msg'); m.textContent = text; m.className = 'msg show ' + (kind || 'info');
    clearTimeout(msgTimer);
    if (kind === 'good') msgTimer = setTimeout(hideMsg, 5000);
  }
  function hideMsg() { $('msg').className = 'msg'; }
  $('msg').onclick = hideMsg;

  // ---------- 携帯の中の保存場所（写真は大きいので IndexedDB） ----------
  var dbp = null;
  function db() {
    return dbp || (dbp = new Promise(function (ok, ng) {
      var r = indexedDB.open('genba-photo', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('outbox', { keyPath: 'id' }); r.result.createObjectStore('draft'); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { ng(r.error); };
    }));
  }
  function tx(name, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (ok, ng) {
        var t = d.transaction(name, mode), s = t.objectStore(name), out;
        var req = fn(s); if (req) req.onsuccess = function () { out = req.result; };
        t.oncomplete = function () { ok(out); }; t.onerror = function () { ng(t.error); }; t.onabort = function () { ng(t.error); };
      });
    });
  }
  var idb = {
    all: function () { return tx('outbox', 'readonly', function (s) { return s.getAll(); }).then(function (l) { return (l || []).sort(function (a, b) { return a.id < b.id ? -1 : 1; }); }); },
    put: function (r) { return tx('outbox', 'readwrite', function (s) { s.put(r); }); },
    del: function (id) { return tx('outbox', 'readwrite', function (s) { s.delete(id); }); },
    getDraft: function () { return tx('draft', 'readonly', function (s) { return s.get('photo'); }); },
    setDraft: function (v) { return tx('draft', 'readwrite', function (s) { if (v) s.put(v, 'photo'); else s.delete('photo'); }); }
  };

  // ---------- 撮影者 ----------
  function showWho() { $('who').textContent = store.get('employee') || '（未登録）'; }
  function openSettings() {
    $('employee').value = store.get('employee');
    $('settings-close').hidden = !store.get('employee');
    $('install').hidden = true;
    $('settings').hidden = false;
  }
  $('settings-close').onclick = function () { $('settings').hidden = true; };
  $('open-settings').onclick = openSettings;
  $('save-settings').onclick = function () {
    var name = $('employee').value.trim();
    if (!name) { show('撮影者（社員名）を入れてください。', 'err'); return; }
    store.set('employee', name); showWho(); $('settings').hidden = true;
    show(name + ' さんで登録しました。', 'good');
    if (ios || android) showInstall();
  };
  showWho();

  // ---------- 現場名（前に使ったものを候補に出す） ----------
  function sites() { try { return JSON.parse(store.get('sites') || '[]'); } catch (e) { return []; } }
  function showSites() {
    $('site-list').innerHTML = '';
    sites().forEach(function (s) { var o = document.createElement('option'); o.value = s; $('site-list').appendChild(o); });
    // 新しく使った順に8件までボタンで並べる（押すと現場名に入る）
    var box = $('recent'); box.innerHTML = '';
    sites().slice(0, 8).forEach(function (s) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = s;
      if (s === $('site').value.trim()) b.className = 'on';
      b.onclick = function () { $('site').value = s; store.set('site', s); showSites(); };
      box.appendChild(b);
    });
    box.hidden = !sites().length;
  }
  function rememberSite(s) { store.set('sites', JSON.stringify([s].concat(sites().filter(function (x) { return x !== s; })).slice(0, 30))); showSites(); }
  $('site').value = store.get('site');
  $('site').addEventListener('input', function () { store.set('site', $('site').value); showSites(); });
  showSites();

  // ---------- 写真 ----------
  var photo = null; // { data: base64(JPEG), shot: 'YYYY-MM-DD HH:MM', w, h }
  function pad(n) { return ('0' + n).slice(-2); }
  function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function now() { return fmt(new Date()); }

  // EXIF の撮影日時（DateTimeOriginal）を読む。なければ null
  function exifDate(buf) {
    try {
      var v = new DataView(buf);
      if (v.getUint16(0) !== 0xFFD8) return null;
      var p = 2;
      while (p + 4 < v.byteLength) {
        var mk = v.getUint16(p), len = v.getUint16(p + 2);
        if (mk === 0xFFE1 && v.getUint32(p + 4) === 0x45786966) { // "Exif"
          var t = p + 10, le = v.getUint16(t) === 0x4949;
          var u16 = function (o) { return v.getUint16(t + o, le); }, u32 = function (o) { return v.getUint32(t + o, le); };
          var find = function (ifd, tag) {
            var n = u16(ifd);
            for (var i = 0; i < n; i++) { var e = ifd + 2 + i * 12; if (u16(e) === tag) return e; }
            return -1;
          };
          var ifd0 = u32(4), ex = find(ifd0, 0x8769);
          var e = ex >= 0 ? find(u32(ex + 8), 0x9003) : -1;
          if (e < 0) e = find(ifd0, 0x0132); // DateTime
          if (e < 0) return null;
          var off = u32(e + 8), s = '';
          for (var k = 0; k < 19; k++) s += String.fromCharCode(v.getUint8(t + off + k));
          var m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/);
          return m && m[1] !== '0000' ? m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] : null;
        }
        if ((mk & 0xFF00) !== 0xFF00) return null;
        p += 2 + len;
      }
    } catch (e) {}
    return null;
  }

  function loadImage(file) {
    return new Promise(function (ok, ng) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { ok(img); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); };
      img.onerror = function () { URL.revokeObjectURL(url); ng(new Error('写真を読み込めませんでした。')); };
      img.src = url;
    });
  }

  function pick(file, fromCamera) {
    if (!file) return;
    show('写真を準備しています…', 'info');
    var shotP = file.arrayBuffer ? file.arrayBuffer().then(exifDate, function () { return null; }) : Promise.resolve(null);
    Promise.all([loadImage(file), shotP]).then(function (r) {
      var img = r[0], w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, MAX_PX / Math.max(w, h));
      var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); // 携帯のブラウザは写真の向きを直して描く
      var shot = r[1] || (fromCamera ? now() : (file.lastModified ? fmt(new Date(file.lastModified)) : now()));
      setPhoto({ data: c.toDataURL('image/jpeg', QUALITY).split(',')[1], shot: shot, w: c.width, h: c.height });
      idb.setDraft(photo).catch(function () {});
      hideMsg();
    }, function (e) { show(e.message, 'err'); });
  }
  function setPhoto(p) {
    photo = p;
    $('preview').hidden = !p; $('photo-empty').hidden = !!p; $('photo-clear').hidden = !p;
    $('preview').src = p ? 'data:image/jpeg;base64,' + p.data : '';
    $('shot-at').textContent = p ? '撮影日時：' + p.shot + '　撮影者：' + (store.get('employee') || '（未登録）') : '';
  }
  $('camera').onchange = function () { pick(this.files[0], true); this.value = ''; };
  $('album').onchange = function () { pick(this.files[0], false); this.value = ''; };
  $('photo-clear').onclick = function () { setPhoto(null); idb.setDraft(null).catch(function () {}); };
  // カメラから戻ったときに画面が読み直されても、撮った写真は残す
  idb.getDraft().then(function (p) { if (p && !photo) setPhoto(p); }, function () {});

  // ---------- コメント（音声入力） ----------
  var ta = $('comment');
  ta.value = store.get('draft_comment');
  function keep() { store.set('draft_comment', ta.value); }
  ['input', 'change', 'keyup', 'compositionend', 'blur'].forEach(function (ev) { ta.addEventListener(ev, keep); });

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, recording = false, startAt = 0, tick = null, base = '';
  if (!SR) { $('rec').hidden = true; $('no-speech').hidden = false; }
  function startRec() {
    rec = new SR();
    rec.lang = 'ja-JP'; rec.continuous = true; rec.interimResults = true;
    base = ta.value ? ta.value.replace(/\s*$/, '') + '\n' : '';
    rec.onresult = function (e) {
      var fin = '', mid = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) fin += e.results[i][0].transcript; else mid += e.results[i][0].transcript;
      }
      if (fin) { base += fin; ta.value = base; keep(); }
      $('interim').textContent = mid;
    };
    rec.onspeechstart = hideMsg;
    rec.onerror = function (e) {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      show('「話す」が使えません（' + e.error + '）。コメント欄をタップして、キーボードのマイクで話してください。', 'err');
      stopRec();
    };
    rec.onend = function () { if (recording) { try { rec.start(); } catch (e) { stopRec(); } } };
    try { rec.start(); } catch (e) { show('音声認識を始められませんでした。キーボードのマイクで話してください。', 'err'); return; }
    recording = true; startAt = Date.now();
    tick = setInterval(function () { if (Date.now() - startAt > MAX_SEC * 1000) stopRec(); }, 500);
    $('rec').textContent = '止める'; $('rec').classList.add('on'); $('rec').setAttribute('aria-pressed', 'true');
    show('聞き取り中です。話してください。', 'info');
  }
  function stopRec() {
    recording = false; clearInterval(tick);
    if (rec) { try { rec.stop(); } catch (e) {} }
    $('rec').textContent = '話す'; $('rec').classList.remove('on'); $('rec').setAttribute('aria-pressed', 'false');
    $('interim').textContent = '';
  }
  $('rec').onclick = function () { if (recording) stopRec(); else startRec(); };

  // ---------- Google ログイン（Google ドライブの許可：このアプリが作ったファイルだけ） ----------
  var token = null, tokenExp = 0, tokenClient = null;
  try { var t0 = JSON.parse(localStorage.getItem('drive_token') || 'null'); if (t0 && t0.exp > Date.now()) { token = t0.token; tokenExp = t0.exp; } } catch (e) {}
  function hasToken() { return token && tokenExp - 60000 > Date.now(); }
  function dropToken() { token = null; tokenExp = 0; store.del('drive_token'); }
  function getToken() {
    if (hasToken()) return Promise.resolve(token);
    return new Promise(function (resolve, reject) {
      if (!window.GOOGLE_CLIENT_ID) return reject(new Error('Google の設定（クライアント ID）がまだです。管理者に連絡してください。'));
      if (!window.google || !google.accounts || !google.accounts.oauth2) return reject(new Error('Google のログイン画面を読み込めませんでした。電波を確かめてください。'));
      tokenClient = tokenClient || google.accounts.oauth2.initTokenClient({ client_id: window.GOOGLE_CLIENT_ID, scope: SCOPE, callback: function () {} });
      tokenClient.callback = function (r) {
        if (r.error || !r.access_token) return reject(new Error('Google のログイン・許可ができませんでした（' + (r.error || '不明') + '）。'));
        if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(r, DRIVE)) return reject(new Error('「Google ドライブ」の許可にチェックを入れてください。'));
        token = r.access_token; tokenExp = Date.now() + Number(r.expires_in || 3600) * 1000;
        try { localStorage.setItem('drive_token', JSON.stringify({ token: token, exp: tokenExp })); } catch (e) {}
        rememberAccount(token);
        resolve(token);
      };
      tokenClient.error_callback = function (e) { reject(new Error(e && e.type === 'popup_closed' ? 'Google のログイン画面が閉じられました。もう一度送ってください。' : 'Google のログイン画面を開けませんでした。')); };
      var opt = { prompt: store.get('drive_ok') ? '' : 'consent' };
      if (store.get('google_email')) opt.login_hint = store.get('google_email');
      tokenClient.requestAccessToken(opt);
    });
  }
  function rememberAccount(tk) {
    if (store.get('google_email')) return;
    fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { 'Authorization': 'Bearer ' + tk } })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (u) { if (u.email) store.set('google_email', u.email); }, function () {});
  }

  // ---------- Google ドライブに保存 ----------
  // 通信できないときは e.offline（携帯に保存して後で送る）
  function api(url, opt) {
    return fetch(url, opt).then(function (res) {
      if (res.ok) return res.json();
      if (res.status === 401) dropToken();
      return res.json().catch(function () { return {}; }).then(function (j) {
        var e = new Error(res.status === 401 ? 'Google の許可が切れました。もう一度送ってください。' :
          res.status === 403 && /has not been used|disabled/i.test((j.error && j.error.message) || '') ? 'Google ドライブの機能（API）が有効になっていません。管理者に連絡してください。' :
          '保存できませんでした（' + res.status + (j.error && j.error.message ? '：' + j.error.message : '') + '）。');
        e.status = res.status; throw e;
      });
    }, function () { var e = new Error('電波がないため送れませんでした。'); e.offline = true; throw e; });
  }
  // 保存先のフォルダ（このアプリが作ったもの）。なければ作る
  function folderId(tk) {
    if (store.get('drive_folder')) return Promise.resolve(store.get('drive_folder'));
    var q = "mimeType='application/vnd.google-apps.folder' and name='" + FOLDER + "' and trashed=false";
    return api('https://www.googleapis.com/drive/v3/files?fields=files(id)&q=' + encodeURIComponent(q), { headers: { 'Authorization': 'Bearer ' + tk } })
      .then(function (j) {
        if (j.files && j.files.length) return j.files[0].id;
        return api('https://www.googleapis.com/drive/v3/files?fields=id', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + tk, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder', appProperties: { genbaFolder: '1' } })
        }).then(function (f) { return f.id; });
      })
      .then(function (id) { store.set('drive_folder', id); return id; });
  }
  function bytes(b64s) { var bin = atob(b64s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function safeName(s) { return String(s || '').replace(/[\\\/:*?"<>|\s]/g, '').slice(0, 30); }
  function upload(tk, folder, r) {
    // 事務所の画面（office.js）が読む形：description に JSON、appProperties.genba = 'v1'
    var meta = {
      name: r.shot.replace(/[-:]/g, '').replace(' ', '_') + '_' + safeName(r.employee) + '_' + safeName(r.site) + '.jpg',
      parents: [folder], mimeType: 'image/jpeg',
      description: JSON.stringify({ id: r.id, site: r.site, employee: r.employee, shot: r.shot, created: r.created, comment: r.comment || '' }),
      appProperties: { genba: 'v1', rid: r.id }
    };
    var bd = 'genba' + r.id;
    var body = new Blob(['--' + bd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + bd + '\r\nContent-Type: image/jpeg\r\n\r\n', bytes(r.photo), '\r\n--' + bd + '--\r\n']);
    return api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + tk, 'Content-Type': 'multipart/related; boundary=' + bd }, body: body
    });
  }
  function sendOne(r) {
    return getToken().then(function (tk) {
      return folderId(tk).then(function (fid) {
        return upload(tk, fid, r).catch(function (e) {
          if (e.status !== 404) throw e;
          store.del('drive_folder'); // フォルダが消されていたら作り直す
          return folderId(tk).then(function (f2) { return upload(tk, f2, r); });
        });
      }).then(function () { store.set('drive_ok', '1'); });
    });
  }

  // ---------- まだ送れていない写真 ----------
  function showOutbox() { idb.all().then(function (l) { $('outbox').hidden = !l.length; $('outbox-count').textContent = l.length; }, function () {}); }
  var flushing = false;
  function flush(interactive) {
    if (flushing) return Promise.resolve(0);
    if (!interactive && !hasToken()) return Promise.resolve(0);
    flushing = true; var sent = 0;
    function next() {
      return idb.all().then(function (l) {
        if (!l.length) return;
        return sendOne(l[0]).then(function () { return idb.del(l[0].id); }).then(function () { sent++; showOutbox(); return next(); });
      });
    }
    return next().then(function () { flushing = false; return sent; }, function (e) { flushing = false; e.sent = sent; showOutbox(); throw e; });
  }
  $('outbox-send').onclick = function () {
    var btn = this; btn.disabled = true;
    flush(true).then(function (n) { show('保存していた写真を ' + n + ' 件送りました。', 'good'); },
      function (e) { show((e.sent ? e.sent + ' 件送りました。' : '') + e.message + '（写真は携帯に保存したままです）', 'err'); })
      .then(function () { btn.disabled = false; });
  };
  window.addEventListener('online', function () {
    flush(false).then(function (n) { if (n) show('電波が戻ったので、保存していた写真を ' + n + ' 件送りました。', 'good'); }, function () {});
  });
  showOutbox();

  // ---------- 送る ----------
  function clearForm() {
    setPhoto(null); idb.setDraft(null).catch(function () {});
    ta.value = ''; store.del('draft_comment');
    // 現場名は残す（同じ現場で続けて撮るため）
  }
  function saveForLater(r) {
    return idb.put(r).then(function () {
      clearForm(); showOutbox();
      show('写真を携帯に保存しました。電波が戻ったら送ります（送れないときは「今すぐ送る」）。', 'info');
    }, function () { show('携帯に保存できませんでした。電波のある所でもう一度送ってください。', 'err'); });
  }
  $('send').onclick = function () {
    if (recording) stopRec();
    var name = store.get('employee'), site = $('site').value.trim();
    if (!name) { openSettings(); show('先に撮影者（社員名）を登録してください。', 'err'); return; }
    if (!site) { show('現場名を入れてください。', 'err'); $('site').focus(); return; }
    if (!photo) { show('写真を撮ってください。', 'err'); return; }
    var comment = ta.value.trim();
    if (comment.length > 2000) { show('コメントが長すぎます（2000字まで）。', 'err'); return; }
    var r = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), site: site, employee: name, shot: photo.shot, created: now(), comment: comment, photo: photo.data };
    rememberSite(site);
    if (navigator.onLine === false) { saveForLater(r); return; }
    var btn = this; btn.disabled = true; btn.textContent = '送っています…';
    sendOne(r).then(function () {
      clearForm();
      show('「' + site + '」の写真を Google ドライブに保存しました。続けて撮れます。', 'good');
      flush(false).catch(function () {});
    }, function (e) {
      if (e.offline) saveForLater(r);
      else show(e.message + '（写真とコメントは残っています）', 'err');
    }).then(function () { btn.disabled = false; btn.textContent = 'この写真を送る'; });
  };

  // ---------- ホーム画面に追加 ----------
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var android = /Android/.test(navigator.userAgent);
  var deferred = null;
  function showInstall(force) {
    if (!force && (standalone || store.get('install_closed') || !$('settings').hidden)) return;
    $('settings').hidden = true; $('install').hidden = false;
    var unknown = !ios && !android;
    $('install-ios').hidden = !(ios || unknown);
    $('install-android').hidden = !(android || unknown) || !!deferred;
    $('install-btn').hidden = !deferred;
    $('install-done').hidden = !standalone;
  }
  $('open-install').onclick = function () { showInstall(true); };
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; showInstall(); });
  $('install-btn').onclick = function () { if (!deferred) return; deferred.prompt(); deferred.userChoice.then(function () { deferred = null; $('install').hidden = true; }); };
  $('install-close').onclick = function () {
    store.set('install_closed', '1'); $('install').hidden = true;
    if (!store.get('employee')) openSettings();
  };
  if (!store.get('employee')) openSettings();
  else if (location.hash === '#install') showInstall(true);
  else if (ios || android) showInstall();

  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
