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
];
