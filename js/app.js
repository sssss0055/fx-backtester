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

    const curPrice = () => ds.candles[cursor - 1].c;

    function newSession(keepStats) {
      ds = data.generate(data.randomSeed(), 800);
      sctx = engine.createContext(ds.candles);
      cursor = START_VISIBLE;
      position = null;
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
      cchart.draw({
        candles: ds.candles, pair: ds.pair,
        start: Math.max(0, cursor - VIEW_BARS), end: cursor,
        smaCtx: sctx, smas, hlines, lastPrice: curPrice(),
      });
    }

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

    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if ($('view-manual').style.display === 'none') return;
      if (e.code === 'Space') { e.preventDefault(); advance(1); }
      else if (e.key === 'b' || e.key === 'B') openPos(1);
      else if (e.key === 's' || e.key === 'S') openPos(-1);
      else if ((e.key === 'c' || e.key === 'C') && position) closePos(curPrice(), '手動決済');
    });

    newSession(false);
    return { redraw };
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
        `${ds.pair.name} ${ds.tf} · ${ds.candles.length}本 · seed:${ds.seed} · ${result.trades.length}回 · ${ms}ms`;
      redraw();
      toast(`検証完了: ${result.trades.length}トレード / 総損益 ${fmtYen(result.stats.pnl)}`);
    }

    function newData() {
      const seedInput = $('aSeed').value.trim();
      const seed = seedInput ? (parseInt(seedInput, 10) >>> 0) : data.randomSeed();
      ds = data.generate(seed, 1500);
      sctx = engine.createContext(ds.candles);
      result = null;
      $('aSeed').value = '';
      $('aSeed').placeholder = 'seed: ' + seed;
      $('aRunInfo').textContent = `${ds.pair.name} ${ds.tf} · ${ds.candles.length}本 · seed:${seed} · 未実行`;
      $('aStats').innerHTML = '';
      $('aHistBody').innerHTML = '';
      $('aHistEmpty').style.display = 'block';
      chart.drawEquity($('aEquity'), null, START_BAL);
      viewStart = 0;
      syncScroll();
      redraw();
      toast('新データ: ' + ds.pair.name + ' ' + ds.tf + ' (seed: ' + seed + ')');
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
    return { redraw };
  })();

  window.addEventListener('resize', () => { M.redraw(); A.redraw(); });
})();
