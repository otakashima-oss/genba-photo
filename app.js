/* 現場写真：画面の動き（版12）
   撮る：
   1. 現場名を入れる（前に使った現場名はボタンで選べる）
   2. 写真を撮る（アルバムからは複数枚選べる）→ 一覧に足す。長い辺 1600px の JPEG に縮める。撮影日時は写真の情報（EXIF）から読む
   3. 写真ごとにコメント（「話す」、iPhone はキーボードのマイク）
   4. 「アプリに保存」：携帯の中（IndexedDB）に保存する。ここでは送らない
   過去の写真：
   5. 現場名・コメント・日付で探す。現場ごとに並べ、押すと大きく表示（コメントも直せる）
   6. 送る写真を選んで「ドライブへ送る」：本人の Google ドライブの「現場写真（アプリ）」フォルダに保存（Drive API、drive.file）
      現場名・撮影者・撮影日時・コメントは、ファイルの説明（description）に JSON で入れる
   7. 送ったあと「携帯から消しますか？」と聞く。消さない写真は「✓ 送信済」と表示して残す
   事務所の画面（office.html）が、ドライブから指定のフォルダに取り込み、報告書を作る。
   設定（config.js）：window.GOOGLE_CLIENT_ID */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var MAX_SEC = 90, MAX_PX = 1600, QUALITY = 0.82, THUMB_PX = 320;
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
    if (kind === 'good') msgTimer = setTimeout(hideMsg, 6000);
  }
  function hideMsg() { $('msg').className = 'msg'; }
  $('msg').onclick = hideMsg;

  // ---------- 携帯の中の保存場所（IndexedDB） ----------
  // records：保存した写真の情報と小さい写真（一覧用）。photos：大きい写真（id → base64）。
  // draft：撮っている途中の写真。outbox：版11までの「まだ送れていない写真」（起動時に records へ移す）
  var dbp = null;
  function db() {
    return dbp || (dbp = new Promise(function (ok, ng) {
      var r = indexedDB.open('genba-photo', 2);
      r.onupgradeneeded = function () {
        var d = r.result, names = d.objectStoreNames;
        if (!names.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'id' });
        if (!names.contains('draft')) d.createObjectStore('draft');
        if (!names.contains('records')) d.createObjectStore('records', { keyPath: 'id' });
        if (!names.contains('photos')) d.createObjectStore('photos');
      };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { ng(r.error); };
    }));
  }
  // names：使う保存場所（1つか複数）。fn(s) の s は名前→保存場所
  function tx(names, mode, fn) {
    names = [].concat(names);
    return db().then(function (d) {
      return new Promise(function (ok, ng) {
        var t = d.transaction(names, mode), s = {}, out;
        names.forEach(function (n) { s[n] = t.objectStore(n); });
        var req = fn(names.length === 1 ? s[names[0]] : s); if (req) req.onsuccess = function () { out = req.result; };
        t.oncomplete = function () { ok(out); }; t.onerror = function () { ng(t.error); }; t.onabort = function () { ng(t.error); };
      });
    });
  }
  var idb = {
    getDraft: function () { return tx('draft', 'readonly', function (s) { return s.get('photos'); }); },
    setDraft: function (v) { return tx('draft', 'readwrite', function (s) { s.delete('photo'); if (v) s.put(v, 'photos'); else s.delete('photos'); }); },
    allRecords: function () { return tx('records', 'readonly', function (s) { return s.getAll(); }).then(function (l) { return l || []; }); },
    putRecord: function (r) { return tx('records', 'readwrite', function (s) { s.put(r); }); },
    getPhoto: function (id) { return tx('photos', 'readonly', function (s) { return s.get(id); }); },
    // 写真の情報と大きい写真を、いっしょに保存する（片方だけ残らないように）
    addAll: function (list) { return tx(['records', 'photos'], 'readwrite', function (s) { list.forEach(function (x) { s.records.put(x.rec); s.photos.put(x.data, x.rec.id); }); }); },
    removeAll: function (ids) { return tx(['records', 'photos'], 'readwrite', function (s) { ids.forEach(function (id) { s.records.delete(id); s.photos.delete(id); }); }); },
    outbox: function () { return tx('outbox', 'readonly', function (s) { return s.getAll(); }).then(function (l) { return l || []; }); },
    clearOutbox: function (ids) { return tx('outbox', 'readwrite', function (s) { ids.forEach(function (id) { s.delete(id); }); }); }
  };
  // 携帯の中の写真を、消されにくくする（ブラウザが容量不足で勝手に消さないように頼む）
  function askPersist() { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {} }

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

  // ---------- 画面の切り替え（撮る／過去の写真） ----------
  function showView(v) {
    $('v-shoot').hidden = v !== 'shoot'; $('v-past').hidden = v !== 'past';
    $('tab-shoot').className = v === 'shoot' ? 'on' : ''; $('tab-past').className = v === 'past' ? 'on' : '';
    if (v === 'past') { if (recKey) stopRec(); renderPast(); }
  }
  $('tab-shoot').onclick = function () { showView('shoot'); };
  $('tab-past').onclick = function () { showView('past'); };

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
  // photos：[{ key, data: base64(JPEG), thumb: base64(小さいJPEG), shot: 'YYYY-MM-DD HH:MM', comment }]。携帯の中（draft）にも残す
  var photos = [];
  function pad(n) { return ('0' + n).slice(-2); }
  function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function now() { return fmt(new Date()); }
  function newKey() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function shortDate(s) { var m = /^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2})/.exec(s || ''); return m ? Number(m[1]) + '/' + Number(m[2]) + ' ' + m[3] : (s || ''); }

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
  function loadImage(src) {
    return new Promise(function (ok, ng) {
      var url = typeof src === 'string' ? src : URL.createObjectURL(src), img = new Image();
      var done = function () { if (typeof src !== 'string') setTimeout(function () { URL.revokeObjectURL(url); }, 1000); };
      img.onload = function () { ok(img); done(); };
      img.onerror = function () { done(); ng(new Error('写真を読み込めませんでした。')); };
      img.src = url;
    });
  }
  function shrink(img, px, q) {
    var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, px / Math.max(w, h));
    var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); // 携帯のブラウザは写真の向きを直して描く
    return c.toDataURL('image/jpeg', q).split(',')[1];
  }
  // 大きい写真（base64）から一覧用の小さい写真を作る（版11までの下書き・送れていない写真用）
  function thumbOf(b64) { return loadImage('data:image/jpeg;base64,' + b64).then(function (img) { return shrink(img, THUMB_PX, 0.7); }, function () { return ''; }); }
  // 1枚を縮めて一覧に足す
  function addFile(file, fromCamera) {
    var shotP = file.arrayBuffer ? file.arrayBuffer().then(exifDate, function () { return null; }) : Promise.resolve(null);
    return Promise.all([loadImage(file), shotP]).then(function (r) {
      var img = r[0];
      var shot = r[1] || (fromCamera ? now() : (file.lastModified ? fmt(new Date(file.lastModified)) : now()));
      photos.push({ key: newKey(), data: shrink(img, MAX_PX, QUALITY), thumb: shrink(img, THUMB_PX, 0.7), shot: shot, comment: '' });
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
      card.querySelector('img').src = 'data:image/jpeg;base64,' + (p.thumb || p.data);
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
    var n = photos.length, btn = $('save');
    btn.disabled = !n || saving;
    if (!saving) btn.textContent = n ? n + '枚をアプリに保存' : '写真を撮ってください';
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

  // ---------- アプリに保存（送らない） ----------
  // 保存した写真：{ id, site, employee, shot, created, comment, thumb, size, sentAt }（大きい写真は photos に別に入れる）
  var recs = [];
  function loadRecords() { return idb.allRecords().then(function (l) { recs = l; updateBadge(); }); }
  var saving = false;
  $('save').onclick = function () {
    if (recKey) stopRec();
    var name = store.get('employee'), site = $('site').value.trim();
    if (!name) { openSettings(); show('先に撮影者（社員名）を登録してください。', 'err'); return; }
    if (!site) { show('現場名を入れてください。', 'err'); $('site').focus(); return; }
    if (!photos.length) { show('写真を撮ってください。', 'err'); return; }
    rememberSite(site);
    saving = true; render();
    var list = photos.slice(), created = now();
    Promise.all(list.map(function (p) { return p.thumb ? p.thumb : thumbOf(p.data); })).then(function (thumbs) {
      var items = list.map(function (p, i) {
        return { data: p.data, rec: { id: p.key, site: site, employee: name, shot: p.shot, created: created, comment: (p.comment || '').trim().slice(0, 2000), thumb: thumbs[i], size: Math.round(p.data.length * 0.75), sentAt: '' } };
      });
      return idb.addAll(items);
    }).then(function () {
      var keys = list.map(function (p) { return p.key; });
      photos = photos.filter(function (p) { return keys.indexOf(p.key) < 0; });
      saving = false; saveDraft(); render(); askPersist();
      return loadRecords().then(function () { show('「' + site + '」の写真 ' + list.length + ' 枚をアプリに保存しました。送るときは「過去の写真」で選んで送ります。', 'good'); });
    }).catch(function () {
      saving = false; render();
      show('携帯に保存できませんでした。携帯の空き容量を確かめてください（写真とコメントは画面に残っています）。', 'err');
    });
  };

  // 版11までの「まだ送れていない写真」を、保存した写真（まだ送っていない）に移す
  function migrateOutbox() {
    return idb.outbox().then(function (l) {
      if (!l.length) return;
      return Promise.all(l.map(function (r) { return thumbOf(r.photo); })).then(function (thumbs) {
        var items = l.map(function (r, i) { return { data: r.photo, rec: { id: r.id, site: r.site, employee: r.employee, shot: r.shot, created: r.created, comment: r.comment || '', thumb: thumbs[i], size: Math.round(r.photo.length * 0.75), sentAt: '' } }; });
        return idb.addAll(items).then(function () { return idb.clearOutbox(l.map(function (r) { return r.id; })); });
      });
    }).catch(function () {});
  }

  // ---------- 過去の写真：探す・並べる ----------
  var filter = 'all', sel = {}, shown = []; // shown：いま画面に並んでいる順（大きく見るときの前後に使う）
  function updateBadge() {
    var n = recs.filter(function (r) { return !r.sentAt; }).length, b = $('unsent-badge');
    b.hidden = !n; b.textContent = '未送信 ' + n;
  }
  function norm(s) { return String(s || '').normalize ? String(s || '').normalize('NFKC').toLowerCase() : String(s || '').toLowerCase(); }
  // 探す言葉をそろえる：「11/27」「11月27日」「2026/11/7」→「11-27」「2026-11-07」。「11月」→「11-」
  function normTok(t) {
    t = norm(t);
    var d = t.replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '').replace(/\//g, '-');
    if (/^\d[\d-]*$/.test(d) && d.indexOf('-') >= 0) {
      var tail = /-$/.test(d);
      d = d.split('-').filter(Boolean).map(function (x) { return x.length === 1 ? '0' + x : x; }).join('-');
      return d + (tail ? '-' : '');
    }
    return t;
  }
  function matches(r, toks) {
    if (filter === 'unsent' && r.sentAt) return false;
    if (!toks.length) return true;
    var hay = norm(r.site + ' ' + r.comment + ' ' + r.employee + ' ' + r.shot);
    return toks.every(function (t) { return hay.indexOf(t) >= 0; });
  }
  function sizeText(n) { var mb = n / 1048576; return mb < 1 ? Math.max(1, Math.round(n / 1024)) + 'KB' : (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + 'MB'; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function renderPast() {
    var toks = $('q').value.trim().split(/[\s　]+/).filter(Boolean).map(normTok);
    var list = recs.filter(function (r) { return matches(r, toks); });
    // 現場ごとにまとめる。新しく撮った現場が上、現場の中も新しい写真が上
    var groups = {}, order = [];
    list.forEach(function (r) { if (!groups[r.site]) { groups[r.site] = []; order.push(r.site); } groups[r.site].push(r); });
    order.forEach(function (s) { groups[s].sort(function (a, b) { return (b.shot + b.id).localeCompare(a.shot + a.id); }); });
    order.sort(function (a, b) { return groups[b][0].shot.localeCompare(groups[a][0].shot); });
    var box = $('past-list'); box.innerHTML = ''; shown = [];
    if (!list.length) {
      box.appendChild(el('div', 'empty', recs.length ? '見つかりませんでした。探す言葉を変えてください。' : 'まだ保存した写真はありません。「撮る」で写真を撮って「アプリに保存」してください。'));
    }
    order.forEach(function (site) {
      var g = groups[site], sent = g.filter(function (r) { return r.sentAt; }).length;
      var days = g.map(function (r) { return r.shot.slice(0, 10); }).sort();
      var dayLabel = function (d) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d); return m ? Number(m[2]) + '/' + Number(m[3]) : d; };
      var first = days[0], last = days[days.length - 1];
      var range = first === last ? dayLabel(first) : dayLabel(first) + '〜' + dayLabel(last);
      var gr = el('div', 'group'), head = el('div', 'ghead'), nm = el('div', 'gname');
      nm.appendChild(el('b', '', site));
      var info = el('span', '', g.length + '枚・' + range + '　');
      info.appendChild(el('span', 'gsent', sent === g.length ? '✓ 全部送信済' : sent ? '✓ 送信済 ' + sent + '枚' : ''));
      if (!sent) info.appendChild(el('span', '', '未送信'));
      nm.appendChild(info); head.appendChild(nm);
      var allSel = g.every(function (r) { return sel[r.id]; });
      var gb = el('button', '', allSel ? '全部外す' : '全部選ぶ'); gb.type = 'button';
      gb.onclick = function () { g.forEach(function (r) { if (allSel) delete sel[r.id]; else sel[r.id] = 1; }); renderPast(); };
      head.appendChild(gb); gr.appendChild(head);
      var grid = el('div', 'grid');
      g.forEach(function (r) {
        var idx = shown.length; shown.push(r);
        var th = el('div', 'th' + (sel[r.id] ? ' sel' : '') + (r.sentAt ? ' is-sent' : ''));
        var pic = el('div', 'pic'), img = el('img'); img.alt = ''; img.loading = 'lazy';
        if (r.thumb) img.src = 'data:image/jpeg;base64,' + r.thumb;
        pic.appendChild(img);
        if (r.sentAt) pic.appendChild(el('div', 'sent', '✓ 送信済'));
        var chk = el('button', 'chk', sel[r.id] ? '✓' : ''); chk.type = 'button'; chk.setAttribute('aria-label', '送る写真に選ぶ');
        chk.onclick = function (e) { e.stopPropagation(); if (sel[r.id]) delete sel[r.id]; else sel[r.id] = 1; renderPast(); };
        pic.appendChild(chk);
        th.appendChild(pic);
        th.appendChild(el('div', 'cap', shortDate(r.shot)));
        if (r.comment) th.appendChild(el('div', 'ctext', r.comment));
        th.onclick = function () { openViewer(idx); };
        grid.appendChild(th);
      });
      gr.appendChild(grid); box.appendChild(gr);
    });
    // 使っている容量（写真の大きさの合計）
    $('usage').textContent = recs.length ? '携帯に ' + recs.length + '枚（約' + sizeText(recs.reduce(function (a, r) { return a + (r.size || 0); }, 0)) + '）' : '';
    showSelBar();
  }
  function selIds() { return recs.filter(function (r) { return sel[r.id]; }).map(function (r) { return r.id; }); }
  function showSelBar() {
    var n = selIds().length;
    $('sel-count').textContent = n ? n + '枚を選んでいます' : '送る写真は、右上の ○ を押して選びます';
    $('sel-clear').hidden = !n; $('usage').hidden = !!n;
    $('sel-send').disabled = !n || sendingNow;
    $('sel-share').disabled = !n || sendingNow;
    $('sel-del').disabled = !n || sendingNow;
    if (!sendingNow) $('sel-send').textContent = n ? n + '枚をドライブへ送る' : 'ドライブへ送る';
  }
  var qTimer = null;
  $('q').addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(renderPast, 200); });
  Array.prototype.forEach.call(document.querySelectorAll('.filters button'), function (b) {
    b.onclick = function () {
      filter = b.dataset.f;
      Array.prototype.forEach.call(document.querySelectorAll('.filters button'), function (x) { x.className = x === b ? 'on' : ''; });
      renderPast();
    };
  });
  $('sel-clear').onclick = function () { sel = {}; renderPast(); };

  // 携帯から消す（元に戻せない）
  function removeRecords(ids) {
    return idb.removeAll(ids).then(function () {
      ids.forEach(function (id) { delete sel[id]; });
      return loadRecords();
    }).then(renderPast);
  }
  $('sel-del').onclick = function () {
    var ids = selIds(); if (!ids.length) return;
    var unsent = recs.filter(function (r) { return sel[r.id] && !r.sentAt; }).length;
    if (!confirm('選んだ ' + ids.length + ' 枚を、この携帯から消します。元に戻せません。' + (unsent ? '\n\n※ この中に、まだ送っていない写真が ' + unsent + ' 枚あります。消すと、どこにも残りません。' : '') + '\n\n消しますか？')) return;
    removeRecords(ids).then(function () { show(ids.length + ' 枚を消しました。', 'good'); }, function () { show('消せませんでした。もう一度お試しください。', 'err'); });
  };

  // ---------- 写真を大きく見る ----------
  var vIdx = -1, vTimer = null;
  function vRec() { return shown[vIdx]; }
  function openViewer(i) { vIdx = i; $('viewer').hidden = false; showViewer(); }
  function closeViewer() { saveViewerComment(); $('viewer').hidden = true; vIdx = -1; renderPast(); }
  function showViewer() {
    var r = vRec(); if (!r) { closeViewer(); return; }
    $('v-pos').textContent = (vIdx + 1) + ' / ' + shown.length;
    $('v-prev').disabled = vIdx <= 0; $('v-next').disabled = vIdx >= shown.length - 1;
    var img = $('v-img'); img.src = r.thumb ? 'data:image/jpeg;base64,' + r.thumb : '';
    idb.getPhoto(r.id).then(function (d) { if (d && vRec() === r) img.src = 'data:image/jpeg;base64,' + d; }, function () {});
    var meta = $('v-meta'); meta.innerHTML = '';
    meta.appendChild(el('b', '', r.site)); meta.appendChild(el('br'));
    meta.appendChild(document.createTextNode('撮影日時：' + r.shot + '　撮影者：' + r.employee));
    if (r.from) meta.appendChild(el('span', 'from', r.from + ' さんから受け取り'));
    $('v-comment').value = r.comment || '';
    var s = $('v-sent');
    s.className = 'vsent ' + (r.sentAt ? 'done' : 'not');
    s.textContent = r.sentAt ? '✓ 送信済（' + shortDate(r.sentAt) + '）　送った後に直したコメントは、事務所には届きません' : 'まだ送っていません（この携帯の中だけにあります）';
    $('v-select').textContent = sel[r.id] ? '✓ 選んでいます（外す）' : '送る写真に選ぶ';
  }
  function saveViewerComment() {
    clearTimeout(vTimer);
    var r = vRec(); if (!r) return;
    var v = $('v-comment').value.slice(0, 2000);
    if (v === (r.comment || '')) return;
    r.comment = v; idb.putRecord(r).catch(function () { show('コメントを保存できませんでした。', 'err'); });
  }
  $('v-comment').addEventListener('input', function () { clearTimeout(vTimer); vTimer = setTimeout(saveViewerComment, 500); });
  $('v-comment').addEventListener('blur', saveViewerComment);
  $('v-close').onclick = closeViewer;
  function move(d) { var j = vIdx + d; if (j < 0 || j >= shown.length) return; saveViewerComment(); vIdx = j; showViewer(); }
  $('v-prev').onclick = function () { move(-1); };
  $('v-next').onclick = function () { move(1); };
  // 写真を左右に指で動かすと、前後の写真へ
  var tx0 = null, ty0 = null;
  $('v-area').addEventListener('touchstart', function (e) { if (e.touches.length === 1) { tx0 = e.touches[0].clientX; ty0 = e.touches[0].clientY; } else tx0 = null; }, { passive: true });
  $('v-area').addEventListener('touchend', function (e) {
    if (tx0 == null) return;
    var dx = e.changedTouches[0].clientX - tx0, dy = e.changedTouches[0].clientY - ty0; tx0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1);
  }, { passive: true });
  $('v-select').onclick = function () { var r = vRec(); if (!r) return; if (sel[r.id]) delete sel[r.id]; else sel[r.id] = 1; showViewer(); };
  $('v-del').onclick = function () {
    var r = vRec(); if (!r) return;
    if (!confirm('この写真を、この携帯から消します。元に戻せません。' + (r.sentAt ? '' : '\n\n※ まだ送っていない写真です。消すと、どこにも残りません。') + '\n\n消しますか？')) return;
    idb.removeAll([r.id]).then(function () {
      delete sel[r.id];
      recs = recs.filter(function (x) { return x.id !== r.id; }); updateBadge();
      shown.splice(vIdx, 1);
      if (!shown.length) { closeViewer(); return; }
      if (vIdx >= shown.length) vIdx = shown.length - 1;
      showViewer();
      show('消しました。', 'good');
    }, function () { show('消せませんでした。', 'err'); });
  };

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
  // 通信できないときは e.offline
  function api(url, opt) {
    return fetch(url, opt).then(function (res) {
      if (res.ok) return res.json();
      if (res.status === 401) dropToken();
      return res.json().catch(function () { return {}; }).then(function (j) {
        var e = new Error(res.status === 401 ? 'Google の許可が切れました。もう一度送ってください。' :
          res.status === 403 && /has not been used|disabled/i.test((j.error && j.error.message) || '') ? 'Google ドライブの機能（API）が有効になっていません。管理者に連絡してください。' :
          '送れませんでした（' + res.status + (j.error && j.error.message ? '：' + j.error.message : '') + '）。');
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

  // ---------- 選んだ写真をドライブへ送る ----------
  var sendingNow = false;
  $('sel-send').onclick = function () {
    var list = recs.filter(function (r) { return sel[r.id]; }).sort(function (a, b) { return (a.shot + a.id).localeCompare(b.shot + b.id); });
    if (!list.length) return;
    if (!store.get('employee')) { openSettings(); show('先に撮影者（社員名）を登録してください。', 'err'); return; }
    var already = list.filter(function (r) { return r.sentAt; }).length;
    if (already && !confirm('選んだ中の ' + already + ' 枚は、もう送信済みです。もう一度送りますか？\n（事務所で取り込み済みの写真は、二重には入りません）')) return;
    if (navigator.onLine === false) { show('電波がないため送れません。電波のある所で、もう一度「ドライブへ送る」を押してください（写真は携帯に残っています）。', 'err'); return; }
    var btn = $('sel-send'), total = list.length, done = [];
    sendingNow = true; showSelBar();
    function next(i) {
      if (i >= list.length) return Promise.resolve();
      var r = list[i];
      btn.textContent = '送っています…（' + (i + 1) + ' / ' + total + '枚）';
      return idb.getPhoto(r.id).then(function (data) {
        if (!data) throw new Error('「' + r.site + '」' + r.shot + ' の写真が携帯の中に見つかりませんでした。');
        return sendOne({ id: r.id, site: r.site, employee: r.employee, shot: r.shot, created: r.created, comment: r.comment, photo: data });
      }).then(function () {
        r.sentAt = now();
        return idb.putRecord(r);
      }).then(function () { done.push(r); return next(i + 1); });
    }
    next(0).then(function () { return null; }, function (e) { return e; }).then(function (err) {
      sendingNow = false;
      done.forEach(function (r) { delete sel[r.id]; });
      updateBadge(); renderPast();
      if (err) show((done.length ? done.length + '枚は送りました。' : '') + err.message + '（送れなかった写真は、選んだまま携帯に残っています）', 'err');
      if (!done.length) return;
      // 送った写真を携帯から消すか聞く。消さない写真は「✓ 送信済」と表示して残す
      setTimeout(function () {
        if (confirm(done.length + ' 枚を Google ドライブに送りました。\n\n送った写真を、この携帯から消しますか？\n\n「OK」：消す\n「キャンセル」：残す（「✓ 送信済」と表示します）')) {
          removeRecords(done.map(function (r) { return r.id; })).then(function () { show('送った ' + done.length + ' 枚を携帯から消しました。', 'good'); }, function () { show('消せませんでした。', 'err'); });
        } else if (!err) {
          show(done.length + ' 枚を送りました。携帯にも残しています（「✓ 送信済」の印が付いています）。', 'good');
        }
      }, 50);
    });
  };

  // ---------- ほかの人に渡す（LINE・AirDrop） ----------
  // 選んだ写真とコメントを1つのファイル（中身は JSON の文字。Android の共有で渡せるように .txt）にまとめる。
  // iPhone の共有画面は「押したその場」でしか開けないので、先にファイルを作り、もう一度押してもらう
  var SHARE_MARK = 'genba-photo-share';
  var shareFile = null, shareUrl = null;
  function shareName(list) {
    var ss = []; list.forEach(function (r) { if (ss.indexOf(r.site) < 0) ss.push(r.site); });
    var d = new Date();
    return '現場写真_' + (ss.length === 1 ? safeName(ss[0]).slice(0, 20) : '複数の現場') + '_' + list.length + '枚_' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.txt';
  }
  $('sel-share').onclick = function () {
    var list = recs.filter(function (r) { return sel[r.id]; }).sort(function (a, b) { return (a.shot + a.id).localeCompare(b.shot + b.id); });
    if (!list.length) return;
    show('渡すファイルを作っています…', 'info');
    Promise.all(list.map(function (r) { return idb.getPhoto(r.id); })).then(function (datas) {
      var items = list.map(function (r, i) { return { id: r.id, site: r.site, employee: r.employee, shot: r.shot, created: r.created, comment: r.comment || '', photo: datas[i] || '' }; })
        .filter(function (x) { return x.photo; });
      var body = JSON.stringify({ app: SHARE_MARK, v: 1, from: store.get('employee'), made: now(), items: items });
      shareFile = new File([body], shareName(list), { type: 'text/plain' });
      if (shareUrl) URL.revokeObjectURL(shareUrl);
      shareUrl = URL.createObjectURL(shareFile);
      var sites = []; items.forEach(function (x) { if (sites.indexOf(x.site) < 0) sites.push(x.site); });
      $('share-info').textContent = '準備ができました：' + sites.join('、') + '　' + items.length + '枚（約' + sizeText(shareFile.size) + '）';
      var canShare = navigator.share && navigator.canShare && navigator.canShare({ files: [shareFile] });
      $('share-go').hidden = !canShare;
      var dl = $('share-dl'); dl.hidden = !!canShare; dl.href = shareUrl; dl.download = shareFile.name;
      hideMsg(); $('share').hidden = false;
    }, function () { show('ファイルを作れませんでした。', 'err'); });
  };
  $('share-go').onclick = function () {
    if (!shareFile) return;
    navigator.share({ files: [shareFile], title: shareFile.name.replace(/\.txt$/, '') }).then(function () {
      $('share').hidden = true; sel = {}; renderPast();
      show('渡しました。相手に「過去の写真」→「📥 受け取る」で読み込んでもらってください。', 'good');
    }, function (e) {
      if (e && e.name === 'AbortError') return; // 共有の画面を閉じただけ
      $('share-dl').hidden = false;
      show('共有の画面を開けませんでした。「ファイルを保存する」で保存してから、LINE で送ってください。', 'err');
    });
  };
  $('share-close').onclick = function () { $('share').hidden = true; };

  // ---------- 受け取る ----------
  $('recv-file').onchange = function () {
    var f = this.files && this.files[0]; this.value = '';
    if (!f) return;
    show('読み込んでいます…', 'info');
    (f.text ? f.text() : new Promise(function (ok, ng) { var fr = new FileReader(); fr.onload = function () { ok(fr.result); }; fr.onerror = ng; fr.readAsText(f); }))
      .then(function (t) {
        var j; try { j = JSON.parse(t); } catch (e) { j = null; }
        if (!j || j.app !== SHARE_MARK || !Array.isArray(j.items)) throw new Error('このファイルは、現場写真アプリで渡したファイルではありません。');
        var have = {}; recs.forEach(function (r) { have[r.id] = 1; });
        var fresh = j.items.filter(function (x) { return x && x.id && x.photo && !have[x.id]; });
        var dup = j.items.length - fresh.length, got = now();
        return Promise.all(fresh.map(function (x) { return thumbOf(x.photo); })).then(function (thumbs) {
          var items = fresh.map(function (x, i) {
            return { data: x.photo, rec: { id: String(x.id), site: String(x.site || '現場名なし'), employee: String(x.employee || ''), shot: String(x.shot || ''), created: String(x.created || ''), comment: String(x.comment || '').slice(0, 2000), thumb: thumbs[i], size: Math.round(x.photo.length * 0.75), sentAt: '', from: String(j.from || ''), receivedAt: got } };
          });
          return items.length ? idb.addAll(items) : null;
        }).then(function () {
          if (fresh.length) {
            // 受け取った現場を、現場名の候補にも入れる
            var ss = []; fresh.forEach(function (x) { if (ss.indexOf(x.site) < 0) ss.push(x.site); });
            ss.reverse().forEach(rememberSite);
            askPersist();
          }
          return loadRecords();
        }).then(function () {
          filter = 'all'; $('q').value = '';
          Array.prototype.forEach.call(document.querySelectorAll('.filters button'), function (x) { x.className = x.dataset.f === 'all' ? 'on' : ''; });
          renderPast(); $('past-list').scrollTop = 0;
          show((j.from ? j.from + ' さんから ' : '') + fresh.length + ' 枚を受け取りました。' + (dup ? '（' + dup + ' 枚は、もう入っていたので飛ばしました）' : ''), fresh.length ? 'good' : 'info');
        });
      })
      .catch(function (e) { show(e && e.message && /現場写真アプリ/.test(e.message) ? e.message : '読み込めませんでした。携帯の空き容量か、ファイルが壊れていないかを確かめてください。', 'err'); });
  };

  migrateOutbox().then(loadRecords).catch(function () {});

  // ---------- ホーム画面に追加 ----------
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  var ios = IOS;
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
