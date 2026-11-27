/* 現場写真：画面の動き
   1. 現場名を入れる（前に使った現場名は候補に出る）
   2. 写真を撮る（アルバムからは複数枚選べる）→ 一覧に足す。長い辺 1600px の JPEG に縮める。撮影日時は写真の情報（EXIF）から読む
   3. 写真ごとに「話す」でコメントを文字にする（使えない機種はキーボードのマイク）
   4. 「○枚をまとめて送る」：1枚ずつ、写真を本人の Google ドライブの「現場写真（アプリ）」フォルダに保存する（Drive API、drive.file）
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
    getDraft: function () { return tx('draft', 'readonly', function (s) { return s.get('photos'); }); },
    setDraft: function (v) { return tx('draft', 'readwrite', function (s) { s.delete('photo'); if (v) s.put(v, 'photos'); else s.delete('photos'); }); }
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

  // ---------- 撮った写真の一覧（何枚でも。1枚ごとにコメント） ----------
  // photos：[{ key, data: base64(JPEG), shot: 'YYYY-MM-DD HH:MM', comment }]。携帯の中（IndexedDB）にも残す
  var photos = [];
  function pad(n) { return ('0' + n).slice(-2); }
  function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function now() { return fmt(new Date()); }
  function newKey() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

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
  // 1枚を縮めて一覧に足す
  function addFile(file, fromCamera) {
    var shotP = file.arrayBuffer ? file.arrayBuffer().then(exifDate, function () { return null; }) : Promise.resolve(null);
    return Promise.all([loadImage(file), shotP]).then(function (r) {
      var img = r[0], w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, MAX_PX / Math.max(w, h));
      var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); // 携帯のブラウザは写真の向きを直して描く
      var shot = r[1] || (fromCamera ? now() : (file.lastModified ? fmt(new Date(file.lastModified)) : now()));
      photos.push({ key: newKey(), data: c.toDataURL('image/jpeg', QUALITY).split(',')[1], shot: shot, comment: '' });
    });
  }
  function addFiles(files, fromCamera) {
    files = Array.prototype.slice.call(files || []);
    if (!files.length) return;
    show(files.length > 1 ? files.length + '枚の写真を準備しています…' : '写真を準備しています…', 'info');
    files.reduce(function (p, f) { return p.then(function () { return addFile(f, fromCamera).catch(function () {}); }); }, Promise.resolve())
      .then(function () { saveDraft(); render(); hideMsg(); var l = $('list'); l.scrollTop = l.scrollHeight; });
  }
  function saveDraft() { idb.setDraft(photos.length ? photos : null).catch(function () {}); }
  var draftTimer = null;
  function saveDraftLater() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); }

  function render() {
    var list = $('list');
    Array.prototype.slice.call(list.querySelectorAll('.card')).forEach(function (c) { c.remove(); });
    $('empty').hidden = photos.length > 0;
    photos.forEach(function (p, i) {
      var card = document.createElement('div'); card.className = 'card'; card.dataset.key = p.key;
      card.innerHTML = '<img alt=""><div class="body"><div class="meta"><b>' + (i + 1) + '枚目</b>　撮影日時：' + p.shot + '</div>' +
        '<div class="cm"><textarea placeholder="この写真のコメント（「話す」で声で入れられます）"></textarea>' +
        (SR ? '<button class="mic" type="button">話す</button>' : '') + '</div><div class="interim"></div></div>' +
        '<button class="del" type="button" aria-label="この写真を外す">×</button>';
      card.querySelector('img').src = 'data:image/jpeg;base64,' + p.data;
      var ta = card.querySelector('textarea'); ta.value = p.comment || '';
      ['input', 'change', 'compositionend', 'blur'].forEach(function (ev) { ta.addEventListener(ev, function () { p.comment = ta.value; saveDraftLater(); }); });
      ta.addEventListener('blur', function () { if (/^キーボードの/.test($('msg').textContent)) hideMsg(); });
      // カーソルの位置を覚える（「話す」で、ここに文字を入れる）
      ['click', 'keyup', 'select', 'input', 'blur', 'touchend'].forEach(function (ev) { ta.addEventListener(ev, function () { if (recKey === p.key) return; p.caret = ta.selectionStart; p.caretEnd = ta.selectionEnd; }); });
      var mic = card.querySelector('.mic');
      if (mic) mic.onclick = function () {
        if (IOS) { keyboardMic(p, ta); return; } // iPhone：キーボードのマイク（iPhone の音声入力）を使う
        if (recKey === p.key) stopRec(); else startRec(p);
      };
      if (recKey === p.key) setTimeout(function () { micUI(p.key, true); }, 0); // 描き直しても「止める」の表示を保つ
      card.querySelector('.del').onclick = function () {
        if ((p.comment || '').trim() && !confirm(i + 1 + '枚目の写真とコメントを外しますか？')) return;
        if (recKey === p.key) stopRec();
        photos = photos.filter(function (x) { return x.key !== p.key; }); saveDraft(); render();
      };
      list.appendChild(card);
    });
    var n = photos.length, btn = $('send');
    btn.disabled = !n || sending;
    if (!sending) btn.textContent = n ? n + '枚をまとめて送る' : '写真を撮ってください';
  }
  $('camera').onchange = function () { addFiles(this.files, true); this.value = ''; };
  $('album').onchange = function () { addFiles(this.files, false); this.value = ''; };
  // カメラから戻ったときに画面が読み直されても、撮った写真とコメントは残す
  idb.getDraft().then(function (l) { if (Array.isArray(l) && l.length && !photos.length) { photos = l; render(); } }, function () {});

  // ---------- コメントの音声入力（押した写真のコメント欄の、カーソルの位置に入る） ----------
  // iPhone の決まりごと（実機で分かったこと）：
  //  ・音声認識は「ボタンを押したその場」でしか始められない（あとから時間をおいて始めると動かない）
  //  ・一度止まった音声認識は使い回せない。止めた合図（onend）が来ないこともある
  // そこで：「話す」を押すたびに新しく作ってその場で始める。前のものは、すぐに捨てる。自動で再開はしない
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // iPhone・iPad では、ホーム画面のアプリの音声認識が、開くたびに1回しか聞き取らない（実機で確認）。
  // そこで「話す」は、コメント欄にカーソルを入れてキーボードを出すだけにし、キーボードのマイクで話してもらう（カーソルの位置に入る）
  var IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function keyboardMic(p, ta) {
    var n = (ta.value || '').length, c = (typeof p.caret === 'number' && p.caret <= n) ? p.caret : n;
    ta.focus(); // ボタンを押したその場で呼ぶと、キーボードが出る
    try { ta.setSelectionRange(c, c); } catch (e) {}
    show('キーボードの 🎤（マイク）を押して話してください。話し終わったら、キーボードの「完了」か、画面の空いている所を押します。', 'info');
  }

  var rec = null, recKey = null, target = null, startAt = 0, tick = null, watch = null;
  if (!SR) $('no-speech').hidden = false;
  function cardOf(key) { return key ? $('list').querySelector('.card[data-key="' + key + '"]') : null; }
  function micUI(key, on) {
    var card = cardOf(key); if (!card) return;
    card.classList.toggle('rec-on', on);
    var mic = card.querySelector('.mic'); if (mic) { mic.textContent = on ? '止める' : '話す'; mic.classList.toggle('on', on); }
    if (!on) card.querySelector('.interim').textContent = '';
  }
  // 前の音声認識を、合図を待たずに捨てる
  function discard() {
    var r = rec; rec = null; clearTimeout(watch); clearInterval(tick);
    if (!r) return;
    r.onresult = r.onerror = r.onend = r.onstart = r.onaudiostart = r.onsoundstart = r.onspeechstart = null;
    try { r.abort(); } catch (e) {}
  }
  function finish() { // 画面を「話す」に戻す。「聞き取り中です」のお知らせも消す（エラーのお知らせは残す）
    if (/^聞き取り中/.test($('msg').textContent)) hideMsg();
    if (target) micUI(target.key, false);
    target = null; recKey = null;
  }
  // 写真 p のコメントに入れ始める（ボタンを押したその場で呼ぶこと）
  function startRec(p) {
    discard();
    if (target && target !== p) micUI(target.key, false);
    target = p; recKey = p.key;
    // 入る場所：カーソルを置いた位置。置いていなければ、最後に行を変えて足す
    var text = p.comment || '', c = p.caret, tBase, tAfter;
    if (typeof c === 'number' && c >= 0 && c <= text.length) {
      var ce = (typeof p.caretEnd === 'number' && p.caretEnd >= c && p.caretEnd <= text.length) ? p.caretEnd : c;
      tBase = text.slice(0, c); tAfter = text.slice(ce);
    } else {
      var cur = text.replace(/\s*$/, ''); tBase = cur ? cur + '\n' : ''; tAfter = '';
    }
    p.caretEnd = null;
    var r = new SR(), t = p; // t：この回の入り先（止めたあとに遅れて届いた文字も、ここに入れる）
    var alive = function () { if (rec === r) clearTimeout(watch); };
    r.lang = 'ja-JP'; r.continuous = true; r.interimResults = true;
    r.onstart = r.onaudiostart = r.onsoundstart = alive;
    r.onresult = function (e) {
      if (rec !== r) return;
      alive();
      // この回の確定した文字を、はじめから組み立て直す（重なって届いても二重にならない）
      var fin = '', mid = '';
      for (var i = 0; i < e.results.length; i++) { if (e.results[i].isFinal) fin += e.results[i][0].transcript; else mid += e.results[i][0].transcript; }
      var card = cardOf(t.key);
      if (fin) {
        t.comment = tBase + fin + tAfter;
        t.caret = (tBase + fin).length; // 次に「話す」を押したときは、ここから続ける
        saveDraftLater();
        if (card) card.querySelector('textarea').value = t.comment;
      }
      if (card && recKey === t.key) card.querySelector('.interim').textContent = mid;
    };
    r.onspeechstart = hideMsg;
    r.onerror = function (e) {
      if (rec !== r || e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') show('マイクが許可されていません。「設定」→「Safari」→「マイク」で許可するか、キーボードのマイクで話してください。', 'err');
      else show('「話す」がうまく動きません（' + e.error + '）。もう一度押すか、キーボードのマイクで話してください。', 'err');
      discard(); if (target === t) finish();
    };
    r.onend = function () { if (rec !== r) return; rec = null; clearTimeout(watch); clearInterval(tick); if (target === t) finish(); }; // 話す間があいて止まったら「話す」に戻す
    rec = r;
    try { r.start(); } catch (e) { rec = null; finish(); show('音声認識を始められませんでした。キーボードのマイクで話してください。', 'err'); return; }
    micUI(p.key, true);
    show('聞き取り中です。' + (photos.indexOf(p) + 1) + '枚目のコメントを話してください。', 'info');
    startAt = Date.now();
    tick = setInterval(function () { if (rec === r && Date.now() - startAt > MAX_SEC * 1000) stopRec(); }, 500);
    // 5秒たっても何の合図もない：知らせて「話す」に戻す
    watch = setTimeout(function () { if (rec === r) { discard(); if (target === t) finish(); show('音声認識が始まりませんでした。もう一度「話す」を押すか、コメント欄をタップしてキーボードのマイクで話してください。', 'err'); } }, 5000);
  }
  function stopRec() {
    var r = rec;
    finish(); clearInterval(tick); clearTimeout(watch);
    if (!r) return;
    try { r.stop(); } catch (e) {}
    // 止まった合図が1秒たっても来なければ捨てる（届いた文字はそれまでに入っている）
    setTimeout(function () { if (rec === r) discard(); }, 1000);
  }

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
    flush(true).then(function (n) { show('保存していた写真を ' + n + ' 枚送りました。', 'good'); },
      function (e) { show((e.sent ? e.sent + ' 枚送りました。' : '') + e.message + '（写真は携帯に保存したままです）', 'err'); })
      .then(function () { btn.disabled = false; });
  };
  window.addEventListener('online', function () {
    flush(false).then(function (n) { if (n) show('電波が戻ったので、保存していた写真を ' + n + ' 枚送りました。', 'good'); }, function () {});
  });
  showOutbox();

  // ---------- まとめて送る ----------
  var sending = false;
  function toRecord(p, site, name) {
    return { id: p.key, site: site, employee: name, shot: p.shot, created: now(), comment: (p.comment || '').trim().slice(0, 2000), photo: p.data };
  }
  // 送れなかった分は携帯に保存（電波が戻ったら送る）
  function keepForLater(list) {
    return list.reduce(function (pr, r) { return pr.then(function () { return idb.put(r); }); }, Promise.resolve()).then(function () {
      var keys = list.map(function (r) { return r.id; });
      photos = photos.filter(function (p) { return keys.indexOf(p.key) < 0; }); saveDraft(); render(); showOutbox();
    });
  }
  $('send').onclick = function () {
    if (recKey) stopRec();
    var name = store.get('employee'), site = $('site').value.trim();
    if (!name) { openSettings(); show('先に撮影者（社員名）を登録してください。', 'err'); return; }
    if (!site) { show('現場名を入れてください。', 'err'); $('site').focus(); return; }
    if (!photos.length) { show('写真を撮ってください。', 'err'); return; }
    var empty = photos.filter(function (p) { return !(p.comment || '').trim(); }).length;
    if (empty && !confirm('コメントのない写真が ' + empty + ' 枚あります。このまま送りますか？')) return;
    rememberSite(site);
    var records = photos.map(function (p) { return toRecord(p, site, name); });
    if (navigator.onLine === false) {
      keepForLater(records).then(function () { show(records.length + '枚を携帯に保存しました。電波が戻ったら送ります（送れないときは「今すぐ送る」）。', 'info'); },
        function () { show('携帯に保存できませんでした。電波のある所でもう一度送ってください。', 'err'); });
      return;
    }
    var btn = $('send'), total = records.length, done = 0;
    sending = true; btn.disabled = true;
    function next() {
      if (!records.length) return Promise.resolve();
      var r = records[0];
      btn.textContent = '送っています…（' + (done + 1) + ' / ' + total + '枚）';
      return sendOne(r).then(function () {
        done++; records.shift();
        photos = photos.filter(function (p) { return p.key !== r.id; }); saveDraft(); render();
        return next();
      });
    }
    next().then(function () {
      sending = false; render();
      show('「' + site + '」の写真 ' + total + ' 枚を Google ドライブに保存しました。', 'good');
      flush(false).catch(function () {});
    }, function (e) {
      sending = false;
      if (e.offline) {
        keepForLater(records).then(function () { show((done ? done + '枚は保存しました。' : '') + '残りの ' + records.length + ' 枚は電波がないため携帯に保存しました。電波が戻ったら送ります。', 'info'); });
      } else {
        render();
        show((done ? done + '枚は保存しました。' : '') + e.message + '（残りの写真とコメントは画面に残っています）', 'err');
      }
    });
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
