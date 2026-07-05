/* =====================================================
 * strategies.js — 売買戦略の定義
 *
 * 各戦略は以下のインターフェースを持つオブジェクト:
 *   id      : 一意なID
 *   name    : UI表示名
 *   desc    : 説明文
 *   warmup  : シグナル計算に必要な最小バー数
 *   params  : [{key,label,def,min,max,step}] パラメータ定義(UIが自動生成される)
 *   signal(ctx, i, p, pos) : 'buy' | 'sell' | 'close' | null を返す
 *     ctx : インジケーター計算コンテキスト(engine.jsが提供)
 *     i   : 現在のバー番号(確定足)
 *     p   : パラメータ値のオブジェクト
 *     pos : 現在のポジション(nullまたは {dir:1|-1})
 *
 * 新しい戦略はこの配列にオブジェクトを追加するだけで
 * UIに自動反映される。
 * ===================================================== */
window.FX = window.FX || {};

FX.strategies = [
  {
    id: 'ma_cross',
    name: 'MAクロス(ドテン)',
    desc: '短期SMAが長期SMAを上抜けで買い、下抜けで売り。反対シグナルでドテン。',
    warmup: 210,
    params: [
      { key: 'fast', label: '短期SMA', def: 10, min: 2, max: 100, step: 1 },
      { key: 'slow', label: '長期SMA', def: 50, min: 5, max: 200, step: 1 },
    ],
    signal(ctx, i, p, pos) {
      const f0 = ctx.sma(p.fast, i), s0 = ctx.sma(p.slow, i);
      const f1 = ctx.sma(p.fast, i - 1), s1 = ctx.sma(p.slow, i - 1);
      if (f0 == null || s0 == null || f1 == null || s1 == null) return null;
      if (f1 <= s1 && f0 > s0) return 'buy';
      if (f1 >= s1 && f0 < s0) return 'sell';
      return null;
    },
  },
  {
    id: 'rsi_reversal',
    name: 'RSI逆張り',
    desc: 'RSIが売られすぎで買い、買われすぎで売り。RSIが50に戻ったら決済。',
    warmup: 60,
    params: [
      { key: 'period', label: 'RSI期間',   def: 14, min: 2, max: 50, step: 1 },
      { key: 'os',     label: '売られすぎ', def: 30, min: 5, max: 45, step: 1 },
      { key: 'ob',     label: '買われすぎ', def: 70, min: 55, max: 95, step: 1 },
    ],
    signal(ctx, i, p, pos) {
      const r = ctx.rsi(p.period, i);
      if (r == null) return null;
      if (pos) {
        if (pos.dir > 0 && r >= 50) return 'close';
        if (pos.dir < 0 && r <= 50) return 'close';
        return null;
      }
      if (r < p.os) return 'buy';
      if (r > p.ob) return 'sell';
      return null;
    },
  },
  {
    id: 'donchian_break',
    name: 'ブレイクアウト(ドンチャン)',
    desc: '過去N本の高値を終値が上抜けで買い、安値を下抜けで売り。反対シグナルでドテン。',
    warmup: 120,
    params: [
      { key: 'period', label: 'チャネル期間', def: 20, min: 5, max: 100, step: 1 },
    ],
    signal(ctx, i, p, pos) {
      // 直前バーまでのN本チャネル(当バーは含めない)
      const hi = ctx.highest(p.period, i - 1);
      const lo = ctx.lowest(p.period, i - 1);
      if (hi == null || lo == null) return null;
      const c = ctx.candles[i].c;
      if (c > hi) return 'buy';
      if (c < lo) return 'sell';
      return null;
    },
  },
  {
    id: 'ema_sanpa',
    name: 'EMA3波(クロス→初回タッチ→実体抜け)',
    desc: '20/200EMAクロス後、初回の短期EMAタッチ足(基準足)の高値/安値を終値で抜けたらエントリー。クロス毎に1回のみ。逆クロスで決済。4時間足想定。SL/TPは下の共通設定で(例: SL30/TP60でRR2)。',
    warmup: 210,
    params: [
      { key: 'fast', label: '短期EMA', def: 20, min: 5, max: 100, step: 1 },
      { key: 'slow', label: '長期EMA', def: 200, min: 50, max: 400, step: 1 },
    ],
    signal(ctx, i, p, pos) {
      // 状態リセット(新しいバックテスト実行の検知)
      if (this._lastI === undefined || i <= this._lastI) {
        this._st = { regime: 0, base: null, done: false };
      }
      this._lastI = i;
      const f0 = ctx.ema(p.fast, i), s0 = ctx.ema(p.slow, i);
      const f1 = ctx.ema(p.fast, i - 1), s1 = ctx.ema(p.slow, i - 1);
      if (f0 == null || s0 == null || f1 == null || s1 == null) return null;
      const st = this._st;
      const crossUp = f1 <= s1 && f0 > s0;
      const crossDn = f1 >= s1 && f0 < s0;
      if (crossUp || crossDn) {
        st.regime = crossUp ? 1 : -1;
        st.base = null;
        st.done = false;
        return pos ? 'close' : null; // 逆クロスで手仕舞い
      }
      if (!st.regime || st.done || pos) return null;
      const b = ctx.candles[i];
      if (st.regime === 1) {
        if (b.l <= f0) { st.base = b.h; return null; }   // タッチ(基準足を更新)
        if (st.base !== null && b.c > st.base) { st.done = true; return 'buy'; }
      } else {
        if (b.h >= f0) { st.base = b.l; return null; }
        if (st.base !== null && b.c < st.base) { st.done = true; return 'sell'; }
      }
      return null;
    },
  },
  {
    id: 'ema200_n_break',
    name: '200EMAタッチ・Nブレイク近似(5分足向け)',
    desc: '短期EMAが長期EMAの下なら売り目線(上なら買い)。価格が長期EMAにタッチ(戻り)した後、直近N本の安値/高値を終値で抜けたらエントリー。ゴールド5分足想定。※本家のN計算値利確・RRフィルターは共通SL/TP設定で近似してください。',
    warmup: 310,
    params: [
      { key: 'fast', label: '短期EMA', def: 20, min: 5, max: 100, step: 1 },
      { key: 'slow', label: '長期EMA', def: 200, min: 50, max: 400, step: 1 },
      { key: 'brk', label: 'ブレイク判定本数', def: 3, min: 2, max: 10, step: 1 },
    ],
    signal(ctx, i, p, pos) {
      if (this._lastI === undefined || i <= this._lastI) {
        this._st = { inPull: false };
      }
      this._lastI = i;
      const f0 = ctx.ema(p.fast, i), s0 = ctx.ema(p.slow, i);
      if (f0 == null || s0 == null) return null;
      const st = this._st;
      const b = ctx.candles[i];
      if (f0 < s0) {
        if (pos && pos.dir > 0) return 'close'; // 方向転換で決済
        if (b.h >= s0) { st.inPull = true; return null; } // 200EMAタッチ(戻り)
        if (st.inPull && !pos) {
          const lo = ctx.lowest(p.brk, i - 1);
          if (lo != null && b.c < lo) { st.inPull = false; return 'sell'; }
        }
      } else if (f0 > s0) {
        if (pos && pos.dir < 0) return 'close';
        if (b.l <= s0) { st.inPull = true; return null; }
        if (st.inPull && !pos) {
          const hi = ctx.highest(p.brk, i - 1);
          if (hi != null && b.c > hi) { st.inPull = false; return 'buy'; }
        }
      } else {
        st.inPull = false;
      }
      return null;
    },
  },
];
