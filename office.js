/* 現場写真：事務所の画面（取り込み・報告書）。ブラウザ（Edge・Chrome）だけで動く。サーバー・AI は使わない
   1. Google にログイン（drive.file：このアプリが作ったファイルだけを扱える）
   2. 保存先のフォルダを選ぶ（File System Access API。ファイルサーバーのネットワークドライブも可）。選んだフォルダは IndexedDB に覚える
   3. ドライブの写真（appProperties.genba = 'v1'）を取り込む：<保存先>\<現場名>\ に写真と 記録.json。取り込んだらドライブの写真をゴミ箱へ
   4. 報告書：Excel（ExcelJS）を <現場>\報告書\ に保存。PDF は印刷の画面で保存
   記録.json と写真の名前の形は、以前のパソコン用（server/）と同じ */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var DRIVE = 'https://www.googleapis.com/auth/drive.file';
  var SCOPE = DRIVE + ' email';
  var PER_PAGE = 3;
  var EXCELJS = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';

  function show(text, kind) { var m = $('msg'); m.textContent = text; m.className = 'msg ' + (kind || 'info'); m.hidden = false; m.scrollIntoView({ block: 'nearest' }); }
  function log(line) { var l = $('import-log'); l.hidden = false; l.textContent += line + '\n'; l.scrollTop = l.scrollHeight; }
  function today() { return new Date().toLocaleDateString('sv-SE'); }
  function busy(on) { ['login', 'pick', 'check', 'import', 'excel', 'pdf', 'reload'].forEach(function (id) { $(id).disabled = on; }); }

  if (!window.showDirectoryPicker) { $('unsupported').hidden = false; }

  // ---------- 覚えておく場所（IndexedDB：フォルダ） ----------
  function db() {
    return new Promise(function (ok, ng) {
      var r = indexedDB.open('genba-office', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { ok(r.result); }; r.onerror = function () { ng(r.error); };
    });
  }
  function kv(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (ok, ng) {
        var t = d.transaction('kv', mode), req = fn(t.objectStore('kv')), out;
        if (req) req.onsuccess = function () { out = req.result; };
        t.oncomplete = function () { ok(out); }; t.onerror = function () { ng(t.error); };
      });
    });
  }

  // ---------- Google ログイン ----------
  var token = null, tokenExp = 0, tokenClient = null;
  try { var t0 = JSON.parse(localStorage.getItem('office_token') || 'null'); if (t0 && t0.exp > Date.now()) { token = t0.token; tokenExp = t0.exp; } } catch (e) {}
  function hasToken() { return token && tokenExp - 60000 > Date.now(); }
  function getToken() {
    if (hasToken()) return Promise.resolve(token);
    return new Promise(function (resolve, reject) {
      if (!window.google || !google.accounts || !google.accounts.oauth2) return reject(new Error('Google のログイン画面を読み込めませんでした。インターネットの接続を確かめてください。'));
      tokenClient = tokenClient || google.accounts.oauth2.initTokenClient({ client_id: window.GOOGLE_CLIENT_ID, scope: SCOPE, callback: function () {} });
      tokenClient.callback = function (r) {
        if (r.error || !r.access_token) return reject(new Error('Google にログインできませんでした（' + (r.error || '不明') + '）。'));
        if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(r, DRIVE)) return reject(new Error('「Google ドライブ」の許可にチェックを入れてください。'));
        token = r.access_token; tokenExp = Date.now() + Number(r.expires_in || 3600) * 1000;
        try { localStorage.setItem('office_token', JSON.stringify({ token: token, exp: tokenExp })); } catch (e) {}
        whoAmI(); resolve(token);
      };
      tokenClient.error_callback = function () { reject(new Error('Google のログイン画面が閉じられました。')); };
      var opt = { prompt: localStorage.getItem('office_ok') ? '' : 'consent' };
      var em = localStorage.getItem('office_email'); if (em) opt.login_hint = em;
      tokenClient.requestAccessToken(opt);
    });
  }
  function whoAmI() {
    if (!hasToken()) return;
    fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (u) { if (u.email) { localStorage.setItem('office_email', u.email); localStorage.setItem('office_ok', '1'); $('who').textContent = u.email + ' でログイン中'; } }, function () {});
  }
  whoAmI();
  $('login').onclick = function () { token = null; getToken().then(function () { show('ログインしました。', 'good'); }, function (e) { show(e.message, 'err'); }); };

  function api(url, opt) {
    return getToken().then(function (tk) {
      opt = opt || {}; opt.headers = Object.assign({ Authorization: 'Bearer ' + tk }, opt.headers || {});
      return fetch(url, opt).then(function (res) {
        if (res.ok) return res;
        if (res.status === 401) { token = null; localStorage.removeItem('office_token'); }
        return res.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(res.status === 401 ? 'Google の許可が切れました。もう一度押してください。' : 'Google ドライブでエラー（' + res.status + (j.error && j.error.message ? '：' + j.error.message : '') + '）');
        });
      });
    });
  }

  // ---------- 保存先のフォルダ ----------
  var root = null;
  function showDir() { $('dir').textContent = root ? root.name : '（まだ選んでいません）'; }
  kv('readonly', function (s) { return s.get('root'); }).then(function (h) {
    if (!h) return;
    root = h; showDir();
    // 許可が残っていれば、現場の一覧をすぐ出す（残っていなければ、ボタンを押したときに聞く）
    return h.queryPermission({ mode: 'readwrite' }).then(function (p) { if (p === 'granted') listSites(); });
  }, function () {});
  // 書き込みの許可（押したときに確認する。ブラウザを開き直すと、もう一度聞かれることがある）
  function ensureRoot() {
    if (!root) return Promise.reject(new Error('先に「保存先のフォルダ」を選んでください。'));
    return root.queryPermission({ mode: 'readwrite' }).then(function (p) {
      if (p === 'granted') return root;
      return root.requestPermission({ mode: 'readwrite' }).then(function (p2) {
        if (p2 !== 'granted') throw new Error('保存先のフォルダへの書き込みが許可されませんでした。');
        return root;
      });
    });
  }
  $('pick').onclick = function () {
    if (!window.showDirectoryPicker) return show('このブラウザではフォルダを選べません。Edge か Chrome で開いてください。', 'err');
    window.showDirectoryPicker({ id: 'genba-root', mode: 'readwrite' }).then(function (h) {
      root = h; showDir();
      return kv('readwrite', function (s) { s.put(h, 'root'); });
    }).then(function () { show('保存先を「' + root.name + '」にしました。', 'good'); listSites(); }, function (e) { if (e && e.name !== 'AbortError') show('フォルダを選べませんでした：' + e.message, 'err'); });
  };

  // ---------- ファイルの読み書き ----------
  function siteFolder(site) {
    var s = String(site || '').normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 60);
    return s || '現場名なし';
  }
  function safe(s, n) { return String(s || '').normalize('NFKC').replace(/[\\/:*?"<>|\s\u0000-\u001f]/g, '').slice(0, n || 30) || '不明'; }
  function readText(dir, name) {
    return dir.getFileHandle(name).then(function (h) { return h.getFile(); }).then(function (f) { return f.text(); }, function () { return null; });
  }
  function writeFile(dir, name, data) {
    return dir.getFileHandle(name, { create: true }).then(function (h) { return h.createWritable(); })
      .then(function (w) { return w.write(data).then(function () { return w.close(); }); });
  }
  function readRecords(dir) { return readText(dir, '記録.json').then(function (t) { try { return t ? JSON.parse(t) : []; } catch (e) { return []; } }); }

  // ---------- 3. ドライブから取り込む ----------
  function listDrive() {
    var q = "appProperties has { key='genba' and value='v1' } and trashed=false";
    var out = [];
    function page(tokenStr) {
      var url = 'https://www.googleapis.com/drive/v3/files?pageSize=1000&fields=nextPageToken,files(id,name,description,createdTime)&q=' + encodeURIComponent(q) + (tokenStr ? '&pageToken=' + tokenStr : '');
      return api(url).then(function (r) { return r.json(); }).then(function (j) {
        (j.files || []).forEach(function (f) {
          var m = {}; try { m = JSON.parse(f.description || '{}'); } catch (e) {}
          out.push({ fileId: f.id, id: m.id || f.id, site: m.site || '現場名なし', employee: m.employee || '', shot: m.shot || '', created: m.created || '', comment: m.comment || '' });
        });
        return j.nextPageToken ? page(j.nextPageToken) : out;
      });
    }
    return page('');
  }
  function showDriveList(list) {
    if (!list.length) { $('drive-list').innerHTML = '<p class="hint">ドライブに、まだ取り込んでいない写真はありません。</p>'; return; }
    var by = {};
    list.forEach(function (r) { var b = by[r.site] = by[r.site] || { n: 0, from: r.shot, to: r.shot }; b.n++; if (r.shot < b.from) b.from = r.shot; if (r.shot > b.to) b.to = r.shot; });
    var h = '<table><tr><th>現場名</th><th class="num">枚数</th><th>撮影日時</th></tr>';
    Object.keys(by).sort().forEach(function (k) { var b = by[k]; h += '<tr><td>' + esc(k) + '</td><td class="num">' + b.n + '</td><td>' + esc(b.from) + ' 〜 ' + esc(b.to) + '</td></tr>'; });
    $('drive-list').innerHTML = h + '</table><p class="hint">合計 ' + list.length + ' 枚</p>';
  }
  $('check').onclick = function () {
    busy(true);
    listDrive().then(showDriveList, function (e) { show(e.message, 'err'); }).then(function () { busy(false); });
  };
  $('import').onclick = function () {
    var del = $('del').checked, ok = 0, skip = 0, ng = 0;
    busy(true); $('import-log').textContent = '';
    ensureRoot().then(function () { return listDrive(); }).then(function (list) {
      if (!list.length) { log('ドライブに写真はありません。'); return; }
      log(list.length + ' 枚を取り込みます。');
      list.sort(function (a, b) { return (a.shot + a.id).localeCompare(b.shot + b.id); });
      return list.reduce(function (p, r) {
        return p.then(function () {
          var dir;
          return root.getDirectoryHandle(siteFolder(r.site), { create: true }).then(function (d) { dir = d; return readRecords(dir); })
            .then(function (recs) {
              var already = recs.some(function (x) { return x.id === r.id; });
              var step = already ? Promise.resolve(skip++) :
                api('https://www.googleapis.com/drive/v3/files/' + r.fileId + '?alt=media').then(function (res) { return res.blob(); }).then(function (blob) {
                  var shot = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(r.shot) ? r.shot.slice(0, 16) : '';
                  var file = (shot ? shot.replace(/[-:]/g, '').replace(' ', '_') : 'nodate') + '_' + safe(r.employee, 12) + '_' + String(r.id).slice(-6) + '.jpg';
                  return writeFile(dir, file, blob).then(function () {
                    recs.push({ id: r.id, site: r.site, employee: r.employee, shot: shot, created: r.created, received: today(), comment: r.comment, file: file });
                    recs.sort(function (a, b) { return (a.shot + a.id).localeCompare(b.shot + b.id); });
                    return writeFile(dir, '記録.json', JSON.stringify(recs, null, 1));
                  }).then(function () { ok++; log('取り込み：' + r.site + '／' + r.shot + '／' + r.employee); });
                });
              // フォルダに入ったことを確かめてから、ドライブの写真をゴミ箱へ
              return step.then(function () {
                if (!del) return;
                return api('https://www.googleapis.com/drive/v3/files/' + r.fileId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
              });
            })
            .catch(function (e) { ng++; log('失敗：' + r.site + '／' + r.shot + '（' + e.message + '）'); });
        });
      }, Promise.resolve());
    }).then(function () {
      var t = '取り込み：' + ok + '枚' + (skip ? '、取り込み済みのため飛ばした：' + skip + '枚' : '') + (ng ? '、失敗：' + ng + '枚' : '') + (del ? '。ドライブの写真はゴミ箱へ移しました。' : '。');
      show(t, ng ? 'err' : 'good'); log(t);
      return listDrive().then(showDriveList).then(listSites);
    }, function (e) { show(e.message, 'err'); }).then(function () { busy(false); }, function () { busy(false); });
  };

  // ---------- 4. 報告書 ----------
  function listSites() {
    if (!root) return Promise.resolve();
    return ensureRoot().then(function () {
      var names = [], it = root.values();
      function next() {
        return it.next().then(function (x) {
          if (x.done) return;
          if (x.value.kind !== 'directory') return next();
          var d = x.value;
          return readRecords(d).then(function (recs) { if (recs.length) names.push({ name: d.name, n: recs.length, last: recs.map(function (r) { return r.shot; }).sort().pop() || '' }); return next(); });
        });
      }
      return next().then(function () {
        names.sort(function (a, b) { return b.last.localeCompare(a.last); });
        var sel = $('site'), keep = sel.value; sel.innerHTML = '';
        if (!names.length) sel.innerHTML = '<option value="">（現場がまだありません）</option>';
        names.forEach(function (s) { var o = document.createElement('option'); o.value = s.name; o.textContent = s.name + '（' + s.n + '枚、最後の撮影 ' + s.last + '）'; sel.appendChild(o); });
        if (keep) sel.value = keep;
      });
    }).catch(function (e) { show(e.message, 'err'); });
  }
  $('reload').onclick = function () { listSites(); };

  // 選んだ現場の写真（期間で絞る）。写真は Blob で読む
  function loadReport() {
    var name = $('site').value, from = $('from').value, to = $('to').value;
    if (!name) return Promise.reject(new Error('現場を選んでください。'));
    var dir;
    return ensureRoot().then(function () { return root.getDirectoryHandle(name); }).then(function (d) { dir = d; return readRecords(d); }).then(function (all) {
      var recs = all.filter(function (r) { var d = (r.shot || '').slice(0, 10); return (!from || d >= from) && (!to || d <= to); })
        .sort(function (a, b) { return (a.shot || '').localeCompare(b.shot || ''); });
      if (!recs.length) throw new Error('その期間の写真がありません。');
      return Promise.all(recs.map(function (r) {
        return dir.getFileHandle(r.file).then(function (h) { return h.getFile(); }).then(function (f) { r.blob = f; return r; }, function () { r.blob = null; return r; });
      })).then(function (rs) {
        var people = rs.map(function (r) { return r.employee; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join('、');
        var span = rs[0].shot.slice(0, 10) + ' 〜 ' + rs[rs.length - 1].shot.slice(0, 10);
        return { dir: dir, folder: name, site: rs[0].site || name, recs: rs, span: span,
          info: '撮影期間：' + span + '　写真：' + rs.length + '枚　撮影者：' + people + '　作成日：' + today() };
      });
    });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function loadScript(src) {
    return new Promise(function (ok, ng) { if (window.ExcelJS) return ok(); var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { ng(new Error('Excel の部品を読み込めませんでした。インターネットの接続を確かめてください。')); }; document.head.appendChild(s); });
  }
  function dataUrl(blob) { return new Promise(function (ok, ng) { var fr = new FileReader(); fr.onload = function () { ok(fr.result); }; fr.onerror = ng; fr.readAsDataURL(blob); }); }
  function imgSize(blob) { return createImageBitmap(blob).then(function (b) { var s = { w: b.width, h: b.height }; b.close && b.close(); return s; }, function () { return { w: 4, h: 3 }; }); }

  $('excel').onclick = function () {
    busy(true);
    var R;
    loadReport().then(function (r) { R = r; return loadScript(EXCELJS); }).then(function () {
      var wb = new ExcelJS.Workbook(); wb.creator = '現場写真アプリ';
      var ws = wb.addWorksheet('工事写真報告書', {
        pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
        headerFooter: { oddFooter: '&C&P / &N ページ' }, views: [{ showGridLines: false }]
      });
      ws.columns = [{ width: 56 }, { width: 10 }, { width: 36 }];
      var PHOTO_W = 56 * 7 + 5, BLOCK_H = [22, 22, 22, 160], PHOTO_H = (22 * 3 + 160) * 4 / 3 - 10;
      var thin = { style: 'thin', color: { argb: 'FF8A97A6' } }, box = { top: thin, left: thin, bottom: thin, right: thin };
      ws.mergeCells('A1:C1'); ws.getCell('A1').value = '工事写真報告書'; ws.getCell('A1').font = { size: 16, bold: true }; ws.getCell('A1').alignment = { horizontal: 'center' }; ws.getRow(1).height = 28;
      ws.mergeCells('A2:C2'); ws.getCell('A2').value = '現場名：' + R.site; ws.getCell('A2').font = { size: 12, bold: true };
      ws.mergeCells('A3:C3'); ws.getCell('A3').value = R.info; ws.getCell('A3').font = { size: 10, color: { argb: 'FF5B6875' } };
      ws.getRow(4).height = 6;
      var row = 5;
      return R.recs.reduce(function (p, r, i) {
        return p.then(function () {
          if (i > 0 && i % PER_PAGE === 0) ws.getRow(row - 1).addPageBreak();
          BLOCK_H.forEach(function (h, k) { ws.getRow(row + k).height = h; });
          ws.mergeCells(row, 1, row + 3, 1); ws.getCell(row, 1).border = box;
          [['No.', String(i + 1)], ['撮影日時', r.shot], ['撮影者', r.employee], ['コメント', r.comment || '']].forEach(function (kv2, j) {
            var a = ws.getCell(row + j, 2), b = ws.getCell(row + j, 3);
            a.value = kv2[0]; b.value = kv2[1];
            a.font = { bold: true, size: 10 }; a.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } };
            a.alignment = { vertical: j === 3 ? 'top' : 'middle' }; b.alignment = { vertical: j === 3 ? 'top' : 'middle', wrapText: true };
            a.border = box; b.border = box; b.font = { size: j === 3 ? 11 : 10 };
          });
          var at = row; row += 5; ws.getRow(row - 1).height = 8;
          if (!r.blob) { ws.getCell(at, 1).value = '（写真が見つかりません：' + r.file + '）'; return; }
          return Promise.all([dataUrl(r.blob), imgSize(r.blob)]).then(function (v) {
            var k = Math.min((PHOTO_W - 10) / v[1].w, PHOTO_H / v[1].h), ew = v[1].w * k, eh = v[1].h * k;
            var id = wb.addImage({ base64: v[0], extension: 'jpeg' });
            ws.addImage(id, { tl: { col: ((PHOTO_W - ew) / 2) / PHOTO_W, row: at - 1 + 0.15 }, ext: { width: ew, height: eh }, editAs: 'oneCell' });
          });
        });
      }, Promise.resolve()).then(function () {
        ws.pageSetup.printArea = 'A1:C' + (row - 1);
        return wb.xlsx.writeBuffer();
      });
    }).then(function (buf) {
      var name = '工事写真報告書_' + R.folder + '_' + today() + '.xlsx';
      return R.dir.getDirectoryHandle('報告書', { create: true }).then(function (rd) { return writeFile(rd, name, new Blob([buf])); })
        .then(function () { show('Excel を保存しました：' + root.name + '\\' + R.folder + '\\報告書\\' + name + '（' + R.recs.length + '枚）', 'good'); });
    }).catch(function (e) { show(e.message, 'err'); }).then(function () { busy(false); });
  };

  $('pdf').onclick = function () {
    var w = window.open('', '_blank'); // 押した直後に開く（あとから開くと止められるため）
    if (!w) return show('新しい画面を開けませんでした。ポップアップを許可してください。', 'err');
    w.document.write('<p style="font-family:sans-serif">報告書を準備しています…</p>');
    busy(true);
    loadReport().then(function (R) {
      var pages = [];
      for (var i = 0; i < R.recs.length; i += PER_PAGE) pages.push(R.recs.slice(i, i + PER_PAGE));
      var urls = R.recs.map(function (r) { return r.blob ? URL.createObjectURL(r.blob) : ''; });
      var html = '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>工事写真報告書_' + esc(R.folder) + '_' + today() + '</title><style>' +
        '@page{size:A4 portrait;margin:12mm 12mm 14mm}*{box-sizing:border-box}body{margin:0;font-family:"Yu Gothic UI","Meiryo",sans-serif;color:#1f2933;font-size:10.5pt}' +
        '.page{height:268mm;overflow:hidden;display:flex;flex-direction:column;page-break-after:always;position:relative}.page:last-child{page-break-after:auto}' +
        'h1{font-size:17pt;text-align:center;margin:0 0 2mm;letter-spacing:.3em}.site{font-size:12pt;font-weight:700;margin:0}.info{font-size:9pt;color:#5b6875;margin:1mm 0 3mm}' +
        '.item{flex:none;height:74mm;display:flex;border:1px solid #8a97a6;margin-bottom:4mm}.ph{width:104mm;display:flex;align-items:center;justify-content:center;border-right:1px solid #8a97a6;background:#fafbfc}' +
        '.ph img{max-width:100mm;max-height:70mm}table{flex:1;border-collapse:collapse}th,td{border-bottom:1px solid #c9d3de;padding:1.6mm 2mm;text-align:left;vertical-align:middle}' +
        'th{width:18mm;background:#e8eef5;font-size:9pt;white-space:nowrap}tr.c th,tr.c td{vertical-align:top;border-bottom:0}tr.c td{white-space:pre-wrap;line-height:1.55}' +
        '.foot{position:absolute;bottom:0;width:100%;text-align:center;font-size:8.5pt;color:#5b6875}</style></head><body>' +
        pages.map(function (pg, p) {
          return '<section class="page">' +
            (p === 0 ? '<h1>工事写真報告書</h1><p class="site">現場名：' + esc(R.site) + '</p><p class="info">' + esc(R.info) + '</p>' : '<p class="info">現場名：' + esc(R.site) + '</p>') +
            pg.map(function (r, j) {
              var n = p * PER_PAGE + j;
              return '<div class="item"><div class="ph">' + (urls[n] ? '<img src="' + urls[n] + '">' : '（写真が見つかりません）') + '</div><table>' +
                '<tr><th>No.</th><td>' + (n + 1) + '</td></tr><tr><th>撮影日時</th><td>' + esc(r.shot) + '</td></tr><tr><th>撮影者</th><td>' + esc(r.employee) + '</td></tr>' +
                '<tr class="c"><th>コメント</th><td>' + esc(r.comment) + '</td></tr></table></div>';
            }).join('') + '<div class="foot">' + (p + 1) + ' / ' + pages.length + ' ページ</div></section>';
        }).join('') + '</body></html>';
      w.document.open(); w.document.write(html); w.document.close();
      var imgs = Array.prototype.slice.call(w.document.images);
      return Promise.all(imgs.map(function (im) { return im.complete ? 0 : new Promise(function (ok) { im.onload = im.onerror = ok; }); })).then(function () {
        show('印刷の画面で、プリンターを「PDF として保存」にして保存してください（保存先は ' + root.name + '\\' + R.folder + '\\報告書 がおすすめです）。', 'info');
        w.focus(); w.print();
      });
    }).catch(function (e) { w.close(); show(e.message, 'err'); }).then(function () { busy(false); });
  };

})();
