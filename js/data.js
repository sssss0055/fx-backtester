/* =====================================================
 * data.js — 価格データ生成
 * シード付き乱数(mulberry32)で再現可能な合成OHLCデータを生成。
 * 将来: CSVインポート / API取得もこのモジュールに追加する。
 * ===================================================== */
window.FX = window.FX || {};

FX.data = (() => {
  const PAIRS = [
    { name: 'USD/JPY', base: 150,  pip: 0.01,   dec: 3 },
    { name: 'EUR/JPY', base: 162,  pip: 0.01,   dec: 3 },
    { name: 'GBP/JPY', base: 190,  pip: 0.01,   dec: 3 },
    { name: 'EUR/USD', base: 1.08, pip: 0.0001, dec: 5 },
    { name: 'GBP/USD', base: 1.27, pip: 0.0001, dec: 5 },
  ];
  const TFS = ['M15', 'H1', 'H4'];

  // シード付き乱数(再現性のため)
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 合成価格データを生成する。
   * ボラティリティ・クラスタリングとトレンドレジームの切替を含む。
   * @param {number} seed  乱数シード(同じシード=同じデータ)
   * @param {number} bars  生成する本数
   * @returns {{pair, tf, seed, candles: {o,h,l,c}[]}}
   */
  function generate(seed, bars = 1500) {
    const rnd = mulberry32(seed);
    const pair = PAIRS[Math.floor(rnd() * PAIRS.length)];
    const tf = TFS[Math.floor(rnd() * TFS.length)];
    const candles = [];
    let price = pair.base * (0.97 + rnd() * 0.06);
    let vol = pair.pip * 8;
    let drift = 0;

    for (let i = 0; i < bars; i++) {
      if (rnd() < 0.02) drift = (rnd() - 0.5) * pair.pip * 5;
      if (rnd() < 0.05) vol = pair.pip * (4 + rnd() * 14);
      vol = Math.max(pair.pip * 3, vol * (0.97 + rnd() * 0.06));

      const open = price;
      const n = 4 + Math.floor(rnd() * 4);
      let h = open, l = open, c = open;
      for (let k = 0; k < n; k++) {
        c += drift / n + (rnd() * 2 - 1) * vol;
        if (c > h) h = c;
        if (c < l) l = c;
      }
      h += rnd() * vol * 0.6;
      l -= rnd() * vol * 0.6;
      candles.push({ o: open, h, l, c });
      price = c;
    }
    return { pair, tf, seed, candles };
  }

  const randomSeed = () => Math.floor(Math.random() * 1e9);

  return { PAIRS, TFS, generate, randomSeed };
})();
