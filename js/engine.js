/* =====================================================
 * engine.js — バックテストエンジン
 *
 * 役割:
 *  1. インジケーター計算コンテキスト(キャッシュ付き)の提供
 *  2. 戦略を全データに適用して自動検証を実行
 *  3. 成績統計の算出(手動モードとも共用)
 *
 * 約定モデル(簡易・保守的):
 *  - シグナルは確定足の終値で判定し、同じ終値で約定
 *  - SL/TPは次の足以降の高値/安値で判定。同一足で両方に
 *    到達した場合はSL優先(保守的)
 *  - スプレッド: エントリー時に spreadPips を不利方向に加算
 * ===================================================== */
window.FX = window.FX || {};

FX.engine = (() => {
  const YEN_PER_PIP_PER_LOT = 100; // 1万通貨あたり1pips ≒ 100円(簡易)
  const START_BAL = 1000000;

  /* ---------- インジケーターコンテキスト ---------- */
  function createContext(candles) {
    const cache = new Map();
    const memo = (key, fn) => {
      if (!cache.has(key)) cache.set(key, fn());
      return cache.get(key);
    };

    const smaArr = (p) => memo('sma' + p, () => {
      const out = new Array(candles.length).fill(null);
      let s = 0;
      for (let i = 0; i < candles.length; i++) {
        s += candles[i].c;
        if (i >= p) s -= candles[i - p].c;
        if (i >= p - 1) out[i] = s / p;
      }
      return out;
    });

    const rsiArr = (p) => memo('rsi' + p, () => {
      const out = new Array(candles.length).fill(null);
      let ag = 0, al = 0;
      for (let i = 1; i < candles.length; i++) {
        const d = candles[i].c - candles[i - 1].c;
        const g = Math.max(d, 0), l = Math.max(-d, 0);
        if (i <= p) {
          ag += g / p; al += l / p;
          if (i === p) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
        } else {
          ag = (ag * (p - 1) + g) / p;
          al = (al * (p - 1) + l) / p;
          out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
        }
      }
      return out;
    });

    const hhArr = (p) => memo('hh' + p, () => {
      const out = new Array(candles.length).fill(null);
      for (let i = p - 1; i < candles.length; i++) {
        let m = -Infinity;
        for (let k = i - p + 1; k <= i; k++) m = Math.max(m, candles[k].h);
        out[i] = m;
      }
      return out;
    });

    const llArr = (p) => memo('ll' + p, () => {
      const out = new Array(candles.length).fill(null);
      for (let i = p - 1; i < candles.length; i++) {
        let m = Infinity;
        for (let k = i - p + 1; k <= i; k++) m = Math.min(m, candles[k].l);
        out[i] = m;
      }
      return out;
    });

    const at = (arr, i) => (i >= 0 && i < arr.length ? arr[i] : null);

    return {
      candles,
      sma:     (p, i) => at(smaArr(p), i),
      rsi:     (p, i) => at(rsiArr(p), i),
      highest: (p, i) => at(hhArr(p), i),
      lowest:  (p, i) => at(llArr(p), i),
    };
  }

  /* ---------- 自動検証の実行 ---------- */
  /**
   * @param {object[]} candles OHLC配列
   * @param {object} pair {pip,dec,...}
   * @param {object} strat 戦略オブジェクト(strategies.js)
   * @param {object} params 戦略パラメータ値
   * @param {object} common {lot, slPips, tpPips, spreadPips}
   * @returns {{trades, equity, stats}}
   */
  function run(candles, pair, strat, params, common) {
    const ctx = createContext(candles);
    const pip = pair.pip;
    const { lot, slPips, tpPips, spreadPips } = common;
    const spread = (spreadPips || 0) * pip;

    let pos = null; // {dir, entry, entryIdx, sl, tp}
    const trades = [];
    let balance = START_BAL;
    const equity = [START_BAL];
    let peak = START_BAL, maxDD = 0;

    const close = (exit, idx, reason) => {
      const pips = pos.dir * (exit - pos.entry) / pip;
      const yen = pips * YEN_PER_PIP_PER_LOT * lot;
      balance += yen;
      trades.push({
        dir: pos.dir, entry: pos.entry, exit,
        entryIdx: pos.entryIdx, exitIdx: idx,
        pips, yen, reason,
      });
      equity.push(balance);
      if (balance > peak) peak = balance;
      maxDD = Math.max(maxDD, (peak - balance) / peak * 100);
      pos = null;
    };

    const open = (dir, i) => {
      const entry = candles[i].c + dir * spread; // スプレッド分不利に約定
      pos = {
        dir, entry, entryIdx: i,
        sl: slPips > 0 ? entry - dir * slPips * pip : null,
        tp: tpPips > 0 ? entry + dir * tpPips * pip : null,
      };
    };

    for (let i = strat.warmup; i < candles.length; i++) {
      const bar = candles[i];

      // 1) 保有中ならSL/TP判定(SL優先=保守的)
      if (pos) {
        const { dir, sl, tp } = pos;
        if (sl !== null && ((dir > 0 && bar.l <= sl) || (dir < 0 && bar.h >= sl))) {
          close(sl, i, '損切り');
        } else if (tp !== null && ((dir > 0 && bar.h >= tp) || (dir < 0 && bar.l <= tp))) {
          close(tp, i, '利確');
        }
      }

      // 2) シグナル判定
      const sig = strat.signal(ctx, i, params, pos);
      if (!sig) continue;
      if (sig === 'close') {
        if (pos) close(bar.c, i, 'シグナル決済');
      } else {
        const dir = sig === 'buy' ? 1 : -1;
        if (pos && pos.dir !== dir) close(bar.c, i, 'ドテン'); // 反対シグナル
        if (!pos) open(dir, i);
      }
    }
    // 最終足で強制決済
    if (pos) close(candles[candles.length - 1].c, candles.length - 1, '期間終了');

    return { trades, equity, stats: computeStats(trades, balance, maxDD) };
  }

  /* ---------- 統計 ---------- */
  function computeStats(trades, balance, maxDD) {
    const wins = trades.filter(t => t.pips > 0);
    const losses = trades.filter(t => t.pips <= 0);
    const grossWin = wins.reduce((s, t) => s + t.yen, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.yen, 0));
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pips, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pips, 0) / losses.length) : 0;
    const totalPips = trades.reduce((s, t) => s + t.pips, 0);
    return {
      balance,
      pnl: balance - START_BAL,
      count: trades.length,
      winRate: trades.length ? wins.length / trades.length * 100 : null,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
      rr: (avgWin && avgLoss) ? avgWin / avgLoss : null,
      expectancy: trades.length ? totalPips / trades.length : null, // pips/回
      totalPips,
      maxDD,
    };
  }

  return { run, createContext, computeStats, YEN_PER_PIP_PER_LOT, START_BAL };
})();
