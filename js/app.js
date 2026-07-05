/* =====================================================
 * app.js — UI制御(手動検証 / 自動検証)
 * ===================================================== */
'use strict';
(() => {
  const { engine, chart, data, strategies } = FX;
  const START_BAL = engine.START_BAL;
  const YPP = engine.YEN_PER_PIP_PER_LOT;
  const $ = id => document.getElementById(id);

  /* ---------- 共通ユーティリティ ---------- */
  const fmtYen = v => (v < 0 ? '-' : '') + '¥' + Math.abs(Math.round(v)).toLocaleString();
  const fmtPips = v => (v > 0 ? '+' : '') + v.toFixed(1);

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function renderStatCells(el, stats) {
    const cell = (k, v, cls = '') =>
      `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
    const pf = stats.profitFactor;
    el.innerHTML =
      cell('残高', fmtYen(stats.balance)) +
      cell('総損益', fmtYen(stats.pnl), stats.pnl > 0 ? 'pos' : stats.pnl < 0 ? 'neg' : '') +
      cell('勝率', stats.winRate == null ? '--%' : Math.round(stats.winRate) + '%') +
      cell('トレード数', stats.count) +
      cell('PF', pf == null ? '--' : pf === Infinity ? '∞' : pf.toFixed(2),
        pf != null && pf !== Infinity ? (pf >= 1 ? 'pos' : 'neg') : '') +
      cell('リスクリワード', stats.rr == null ? '--' : stats.rr.toFixed(2)) +
      cell('期待値/回', stats.expectancy == null ? '--' : fmtPips(stats.expectancy) + 'p',
        stats.expectancy > 0 ? 'pos' : stats.expectancy < 0 ? 'neg' : '') +
      cell('最大DD', stats.maxDD.toFixed(1) + '%', stats.maxDD > 10 ? 'neg' : '');
  }

  function renderHistory(tbody, emptyEl, trades, pair, withReason) {
    emptyEl.style.display = trades.length ? 'none' : 'block';
    const fp = v => v.toFixed(pair.dec);
    let html = '';
    for (let i = trades.length - 1; i >= 0; i--) {
      const t = trades[i];
      const cls = t.pips > 0 ? 't-up' : 't-down';
      html += `<tr>
        <td class="${t.dir > 0 ? 't-up' : 't-down'}">${t.dir > 0 ? '買い' : '売り'}</td>
        <td>${fp(t.entry)}</td><td>${fp(t.exit)}</td>
        <td class="${cls}">${fmtPips(t.pips)}</td>
        <td class="${cls}">${fmtYen(t.yen)}</td>
        ${withReason ? `<td class="reason">${t.reason || ''}</td>` : ''}
      </tr>`;
    }
    tbody.innerHTML = html;
  }

  /* ---------- 実データ(CSVインポート)の共有状態 ---------- */
  let importedRaw = null; // {candles(分足など元の粒度), name}
  let imported = null;    // 表示時間足に変換済みのデータセット

  /* ---------- タブ切替 ---------- */
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b === btn));
      $('view-manual').style.display = btn.dataset.view === 'manual' ? '' : 'none';
      $('view-auto').style.display = btn.dataset.view === 'auto' ? '' : 'none';
      if (btn.dataset.view === 'manual') M.redraw(); else A.redraw();
    });
  });

  /* =====================================================
   * M — 手動検証モード
   * ===================================================== */
  const M = (() => {
    const START_VISIBLE = 120, VIEW_BARS = 90;
    const cchart = new chart.CandleChart($('mChart'));
    let ds, cursor, position = null, trades = [], balance = START_BAL;
    let equity = [START_BAL], peak = START_BAL, maxDD = 0;
    let sctx; // インジケーターコンテキスト
    let showSma20 = true, showSma50 = false;
    let showEma20 = false, showEma75 = false, showEma200 = false;
    let drawings = [], tool = null, pendingPt = null, previewPt = null;

    const curPrice = () => ds.candles[cursor - 1].c;

    function newSession(keepStats) {
      if (imported) {
        // 実データ: ランダムな位置から練習用の窓を切り出す(未来を知らない状態で開始)
        const total = imported.candles.length;
        const len = Math.min(800, total);
        const off = Math.floor(Math.random() * Math.max(1, total - len + 1));
        ds = { pair: imported.pair, tf: imported.tf, seed: null, candles: imported.candles.slice(off, off + len) };
      } else {
        ds = data.generate(data.randomSeed(), 800);
      }
      sctx = engine.createContext(ds.candles);
      cursor = Math.min(START_VISIBLE, ds.candles.length);
      position = null;
      drawings = []; pendingPt = null; previewPt = null;
      if (!keepStats) {
        trades = []; balance = START_BAL; equity = [START_BAL]; peak = START_BAL; maxDD = 0;
      }
      $('pairBadge').textContent = ds.pair.name + ' · ' + ds.tf;
      refreshAll();
      toast('新しいチャート: ' + ds.pair.name + ' ' + ds.tf);
    }

    function openPos(dir) {
      if (position) { toast('既にポジションがあります'); return; }
      const lot = Math.max(0.1, parseFloat($('mLot').value) || 1);
      const slp = Math.max(0, parseFloat($('mSl').value) || 0);
      const tpp = Math.max(0, parseFloat($('mTp').value) || 0);
      const entry = curPrice();
      position = {
        dir, entry, lot,
        sl: slp > 0 ? entry - dir * slp * ds.pair.pip : null,
        tp: tpp > 0 ? entry + dir * tpp * ds.pair.pip : null,
      };
      refreshAll();
      toast((dir > 0 ? '買い' : '売り') + ' エントリー @ ' + entry.toFixed(ds.pair.dec));
    }

    const pnlPips = exit => position.dir * (exit - position.entry) / ds.pair.pip;

    function closePos(exit, reason) {
      const pips = pnlPips(exit);
      const yen = pips * YPP * position.lot;
      balance += yen;
      trades.push({ dir: position.dir, entry: position.entry, exit, pips, yen, reason });
      equity.push(balance);
      if (balance > peak) peak = balance;
      maxDD = Math.max(maxDD, (peak - balance) / peak * 100);
      position = null;
      refreshAll();
      toast((reason || '決済') + '  ' + fmtPips(pips) + ' pips / ' + fmtYen(yen));
    }

    function checkStops(bar) {
      if (!position) return;
      const { dir, sl, tp } = position;
      if (sl !== null && ((dir > 0 && bar.l <= sl) || (dir < 0 && bar.h >= sl))) { closePos(sl, '損切り'); return; }
      if (tp !== null && ((dir > 0 && bar.h >= tp) || (dir < 0 && bar.l <= tp))) { closePos(tp, '利確'); }
    }

    function advance(n) {
      for (let i = 0; i < n; i++) {
        if (cursor >= ds.candles.length) { toast('チャートの終端です。新しいチャートを生成してください'); break; }
        cursor++;
        checkStops(ds.candles[cursor - 1]);
      }
      refreshAll();
    }

    function refreshAll() {
      // ヘッダー
      const p = curPrice(), prev = ds.candles[cursor - 2] ? ds.candles[cursor - 2].c : p;
      const tape = $('priceTape');
      tape.textContent = p.toFixed(ds.pair.dec);
      tape.className = 'price-tape ' + (p >= prev ? 'up' : 'down');
      $('candleCount').textContent = `Bar ${cursor - START_VISIBLE} / ${ds.candles.length - START_VISIBLE}`;
      // ポジションUI
      $('mBtnClose').disabled = !position;
      $('mBtnBuy').disabled = !!position;
      $('mBtnSell').disabled = !!position;
      const card = $('mPosCard'), fp = $('mFloatPnl');
      if (position) {
        card.style.display = 'block'; fp.style.display = 'block';
        const dirTxt = position.dir > 0 ? '▲ 買い' : '▼ 売り';
        const col = position.dir > 0 ? 'var(--up)' : 'var(--down)';
        const f = v => v.toFixed(ds.pair.dec);
        $('mPcDir').textContent = dirTxt; $('mPcDir').style.color = col;
        $('mPcLot').textContent = position.lot.toFixed(1) + '万通貨';
        $('mPcEntry').textContent = f(position.entry);
        $('mPcSl').textContent = position.sl ? f(position.sl) : '--';
        $('mPcTp').textContent = position.tp ? f(position.tp) : '--';
        const pips = pnlPips(p), yen = pips * YPP * position.lot;
        $('mFpDir').textContent = dirTxt + ' ' + position.lot.toFixed(1) + '万通貨';
        $('mFpDir').style.color = col;
        $('mFpPips').textContent = fmtPips(pips) + ' pips';
        $('mFpPips').style.color = pips >= 0 ? 'var(--up)' : 'var(--down)';
        $('mFpYen').textContent = fmtYen(yen);
        $('mFpYen').style.color = pips >= 0 ? 'var(--up)' : 'var(--down)';
      } else {
        card.style.display = 'none'; fp.style.display = 'none';
      }
      // 統計・履歴
      renderStatCells($('mStats'), engine.computeStats(trades, balance, maxDD));
      renderHistory($('mHistBody'), $('mHistEmpty'), trades, ds.pair, false);
      chart.drawEquity($('mEquity'), equity, START_BAL);
      redraw();
    }

    function redraw() {
      const hlines = [];
      if (position) {
        hlines.push({ price: position.entry, color: position.dir > 0 ? '#2DD4A7' : '#F0596A', label: 'IN', dash: [6, 4] });
        if (position.sl !== null) hlines.push({ price: position.sl, color: '#F0596A', label: 'SL', dash: [2, 3] });
        if (position.tp !== null) hlines.push({ price: position.tp, color: '#2DD4A7', label: 'TP', dash: [2, 3] });
      }
      const smas = [];
      if (showSma20) smas.push({ period: 20, color: 'rgba(92,168,255,.8)' });
      if (showSma50) smas.push({ period: 50, color: 'rgba(245,181,74,.8)' });
      if (showEma20) smas.push({ period: 20, color: 'rgba(45,212,167,.9)', kind: 'ema' });
      if (showEma75) smas.push({ period: 75, color: 'rgba(240,89,106,.9)', kind: 'ema' });
      if (showEma200) smas.push({ period: 200, color: 'rgba(230,237,243,.7)', kind: 'ema' });
      const preview = (tool === 't' && pendingPt && previewPt)
        ? { type: 't', i1: pendingPt.i, p1: pendingPt.p, i2: previewPt.i, p2: previewPt.p }
        : null;
      cchart.draw({
        candles: ds.candles, pair: ds.pair,
        start: Math.max(0, cursor - VIEW_BARS), end: cursor,
        smaCtx: sctx, smas, hlines, lastPrice: curPrice(),
        drawings, preview,
      });
    }

    /* ---------- ライン描画ツール ---------- */
    const mCv = $('mChart');

    function setTool(t) {
      tool = tool === t ? null : t;
      pendingPt = null; previewPt = null;
      $('mBtnToolH').classList.toggle('on', tool === 'h');
      $('mBtnToolT').classList.toggle('on', tool === 't');
      mCv.style.cursor = tool ? 'crosshair' : '';
      redraw();
    }

    mCv.addEventListener('click', e => {
      if (!tool) return;
      const r = mCv.getBoundingClientRect();
      const price = cchart.priceAt(e.clientY - r.top);
      const idx = cchart.indexAt(e.clientX - r.left);
      if (price == null || idx == null) return;
      if (tool === 'h') {
        drawings.push({ type: 'h', price });
      } else if (!pendingPt) {
        pendingPt = { i: idx, p: price };
      } else {
        drawings.push({ type: 't', i1: pendingPt.i, p1: pendingPt.p, i2: idx, p2: price });
        pendingPt = null; previewPt = null;
      }
      redraw();
    });

    mCv.addEventListener('mousemove', e => {
      if (tool !== 't' || !pendingPt) return;
      const r = mCv.getBoundingClientRect();
      previewPt = { i: cchart.indexAt(e.clientX - r.left), p: cchart.priceAt(e.clientY - r.top) };
      redraw();
    });

    /* events */
    $('mBtnNext').onclick = () => advance(1);
    $('mBtnSkip5').onclick = () => advance(5);
    $('mBtnSkip20').onclick = () => advance(20);
    $('mBtnBuy').onclick = () => openPos(1);
    $('mBtnSell').onclick = () => openPos(-1);
    $('mBtnClose').onclick = () => { if (position) closePos(curPrice(), '手動決済'); };
    $('mBtnNew').onclick = () => {
      if (position && !confirm('ポジション保有中です。破棄して新しいチャートを生成しますか?')) return;
      position = null; newSession(true);
    };
    $('mBtnSma20').onclick = e => { showSma20 = !showSma20; e.target.classList.toggle('on', showSma20); redraw(); };
    $('mBtnSma50').onclick = e => { showSma50 = !showSma50; e.target.classList.toggle('on', showSma50); redraw(); };
    $('mBtnEma20').onclick = e => { showEma20 = !showEma20; e.target.classList.toggle('on', showEma20); redraw(); };
    $('mBtnEma75').onclick = e => { showEma75 = !showEma75; e.target.classList.toggle('on', showEma75); redraw(); };
    $('mBtnEma200').onclick = e => { showEma200 = !showEma200; e.target.classList.toggle('on', showEma200); redraw(); };
    $('mBtnToolH').onclick = () => setTool('h');
    $('mBtnToolT').onclick = () => setTool('t');
    $('mBtnUndoDraw').onclick = () => { drawings.pop(); pendingPt = null; previewPt = null; redraw(); };
    $('mBtnClearDraw').onclick = () => { drawings = []; pendingPt = null; previewPt = null; redraw(); };

    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if ($('view-manual').style.display === 'none') return;
      if (e.code === 'Space') { e.preventDefault(); advance(1); }
      else if (e.key === 'b' || e.key === 'B') openPos(1);
      else if (e.key === 's' || e.key === 'S') openPos(-1);
      else if ((e.key === 'c' || e.key === 'C') && position) closePos(curPrice(), '手動決済');
      else if (e.key === 'Escape' && tool) setTool(tool); // ツール解除
    });

    newSession(false);
    return { redraw, reload: () => newSession(false) };
  })();

  /* =====================================================
   * A — 自動検証モード
   * ===================================================== */
  const A = (() => {
    const cchart = new chart.CandleChart($('aChart'));
    let ds = data.generate(data.randomSeed(), 1500);
    let sctx = engine.createContext(ds.candles);
    let result = null;
    let viewStart = 0, viewBars = 150;

    /* 戦略セレクタとパラメータUIを自動生成 */
    const sel = $('aStrategy');
    strategies.forEach((s, i) => {
      const op = document.createElement('option');
      op.value = s.id; op.textContent = s.name;
      sel.appendChild(op);
    });

    function currentStrategy() {
      return strategies.find(s => s.id === sel.value) || strategies[0];
    }

    function buildParamInputs() {
      const s = currentStrategy();
      $('aStratDesc').textContent = s.desc;
      const box = $('aParams');
      box.innerHTML = '';
      s.params.forEach(p => {
        const div = document.createElement('div');
        div.className = 'field';
        div.innerHTML = `<label>${p.label}</label>
          <input type="number" data-key="${p.key}" value="${p.def}" min="${p.min}" max="${p.max}" step="${p.step}">`;
        box.appendChild(div);
      });
    }

    function readParams() {
      const out = {};
      $('aParams').querySelectorAll('input').forEach(inp => {
        out[inp.dataset.key] = parseFloat(inp.value);
      });
      return out;
    }

    function runBacktest() {
      const strat = currentStrategy();
      const params = readParams();
      const common = {
        lot: Math.max(0.1, parseFloat($('aLot').value) || 1),
        slPips: Math.max(0, parseFloat($('aSl').value) || 0),
        tpPips: Math.max(0, parseFloat($('aTp').value) || 0),
        spreadPips: Math.max(0, parseFloat($('aSpread').value) || 0),
      };
      const t0 = performance.now();
      result = engine.run(ds.candles, ds.pair, strat, params, common);
      const ms = (performance.now() - t0).toFixed(0);
      renderStatCells($('aStats'), result.stats);
      renderHistory($('aHistBody'), $('aHistEmpty'), result.trades, ds.pair, true);
      chart.drawEquity($('aEquity'), result.equity, START_BAL);
      $('aRunInfo').textContent =
        `${ds.pair.name} ${ds.tf} · ${ds.candles.length.toLocaleString()}本 · ${ds.seed == null ? '実データ' : 'seed:' + ds.seed} · ${result.trades.length}回 · ${ms}ms`;
      redraw();
      toast(`検証完了: ${result.trades.length}トレード / 総損益 ${fmtYen(result.stats.pnl)}`);
    }

    function newData() {
      if (imported) {
        // 実データ使用中は全期間をそのまま検証対象にする
        ds = { pair: imported.pair, tf: imported.tf, seed: null, candles: imported.candles };
      } else {
        const seedInput = $('aSeed').value.trim();
        const seed = seedInput ? (parseInt(seedInput, 10) >>> 0) : data.randomSeed();
        ds = data.generate(seed, 1500);
        $('aSeed').value = '';
        $('aSeed').placeholder = 'seed: ' + seed;
      }
      sctx = engine.createContext(ds.candles);
      result = null;
      $('aRunInfo').textContent = `${ds.pair.name} ${ds.tf} · ${ds.candles.length.toLocaleString()}本 · ${ds.seed == null ? '実データ' : 'seed:' + ds.seed} · 未実行`;
      $('aStats').innerHTML = '';
      $('aHistBody').innerHTML = '';
      $('aHistEmpty').style.display = 'block';
      chart.drawEquity($('aEquity'), null, START_BAL);
      viewStart = 0;
      syncScroll();
      redraw();
      toast('データ切替: ' + ds.pair.name + ' ' + ds.tf + ' (' + ds.candles.length.toLocaleString() + '本)');
    }

    function syncScroll() {
      const sc = $('aScroll');
      sc.max = Math.max(0, ds.candles.length - viewBars);
      if (viewStart > sc.max) viewStart = +sc.max;
      sc.value = viewStart;
    }

    function redraw() {
      const smas = [];
      const s = currentStrategy();
      // MAクロス系はパラメータのSMAを表示
      if (s.id === 'ma_cross') {
        const p = readParams();
        smas.push({ period: p.fast || 10, color: 'rgba(92,168,255,.8)' });
        smas.push({ period: p.slow || 50, color: 'rgba(245,181,74,.8)' });
      }
      cchart.draw({
        candles: ds.candles, pair: ds.pair,
        start: viewStart, end: viewStart + viewBars,
        smaCtx: sctx, smas,
        markers: result ? result.trades : null,
      });
    }

    /* events */
    sel.onchange = () => { buildParamInputs(); redraw(); };
    $('aBtnRun').onclick = runBacktest;
    $('aBtnNewData').onclick = newData;
    $('aScroll').oninput = e => { viewStart = +e.target.value; redraw(); };
    $('aZoomIn').onclick = () => { viewBars = Math.max(60, Math.round(viewBars / 1.5)); syncScroll(); redraw(); };
    $('aZoomOut').onclick = () => { viewBars = Math.min(ds.candles.length, Math.round(viewBars * 1.5)); syncScroll(); redraw(); };
    $('aZoomAll').onclick = () => { viewBars = ds.candles.length; viewStart = 0; syncScroll(); redraw(); };

    buildParamInputs();
    $('aRunInfo').textContent = `${ds.pair.name} ${ds.tf} · ${ds.candles.length}本 · seed:${ds.seed} · 未実行`;
    syncScroll();
    return { redraw, reload: newData };
  })();

  /* =====================================================
   * 実データCSVインポート(ヘッダーのボタン群)
   * ===================================================== */
  (() => {
    const TF_LABEL = { 1: 'M1', 5: 'M5', 15: 'M15', 60: 'H1', 240: 'H4', 1440: 'D1' };
    const MAX_BARS = 50000; // 描画・検証の応答性を保つ上限(超過分は新しい方を優先)

    function applyImport() {
      if (!importedRaw) return;
      const mins = parseInt($('csvTf').value, 10);
      let cds = FX.data.resample(importedRaw.candles, mins);
      if (cds.length > MAX_BARS) cds = cds.slice(-MAX_BARS);
      imported = FX.data.fromCandles(cds, importedRaw.name, TF_LABEL[mins]);
      $('csvTf').style.display = '';
      $('btnClearData').style.display = '';
      M.reload();
      A.reload();
      toast(`実データ読込: ${imported.pair.name} ${imported.tf} · ${cds.length.toLocaleString()}本`);
    }

    $('btnImport').onclick = () => $('csvFile').click();

    $('csvFile').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const candles = FX.data.parseCsv(reader.result);
        if (candles.length < 100) {
          toast('CSVを解析できませんでした(対応: HistData ASCII / 日時,O,H,L,C 形式)');
          return;
        }
        const m = file.name.match(/[A-Za-z]{6}/);
        const name = m ? m[0].toUpperCase().replace(/^(.{3})/, '$1/') : file.name.replace(/\.[^.]*$/, '');
        importedRaw = { candles, name };
        applyImport();
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    $('csvTf').onchange = applyImport;

    $('btnClearData').onclick = () => {
      importedRaw = null;
      imported = null;
      $('csvTf').style.display = 'none';
      $('btnClearData').style.display = 'none';
      M.reload();
      A.reload();
      toast('合成データに戻しました');
    };
  })();

  window.addEventListener('resize', () => { M.redraw(); A.redraw(); });
})();
