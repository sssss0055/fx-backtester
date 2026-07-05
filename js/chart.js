/* =====================================================
 * chart.js — Canvasチャート描画
 *
 * CandleChart: ローソク足 + SMA + 水平線 + 売買マーカー
 * drawEquity : 損益カーブ描画
 * ===================================================== */
window.FX = window.FX || {};

FX.chart = (() => {
  const C = {
    up: '#2DD4A7', down: '#F0596A', accent: '#5CA8FF', amber: '#F5B54A',
    grid: 'rgba(30,42,58,.55)', muted: '#7D8CA1', bg: '#0B0F14',
  };

  function sizeCanvas(cv) {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = r.width * dpr;
    cv.height = r.height * dpr;
    cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: r.width, h: r.height };
  }

  class CandleChart {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
    }

    /**
     * @param {object} o
     *  candles, pair, start, end   … 表示範囲 [start, end)
     *  smaCtx      … engine.createContext (SMA描画用、省略可)
     *  smas        … [{period,color}]
     *  hlines      … [{price,color,label,dash}]
     *  markers     … トレード配列 [{dir,entry,exit,entryIdx,exitIdx,pips}]
     *  lastPrice   … 現在値マーカー(省略可)
     */
    draw(o) {
      const { w, h } = sizeCanvas(this.cv);
      const ctx = this.ctx;
      ctx.clearRect(0, 0, w, h);
      const { candles, pair } = o;
      const start = Math.max(0, o.start), end = Math.min(candles.length, o.end);
      const n = end - start;
      if (n <= 0) return;

      const padR = 64, padT = 16, padB = 22;
      let hi = -Infinity, lo = Infinity;
      for (let i = start; i < end; i++) {
        const b = candles[i];
        if (b.h > hi) hi = b.h;
        if (b.l < lo) lo = b.l;
      }
      (o.hlines || []).forEach(l => { if (l.price > hi) hi = l.price; if (l.price < lo) lo = l.price; });
      const pad = (hi - lo) * 0.08 || pair.pip * 10;
      hi += pad; lo -= pad;

      const X = i => ((i - start + 0.5) / n) * (w - padR);
      const Y = p => padT + (hi - p) / (hi - lo) * (h - padT - padB);
      const cw = Math.max(1.5, (w - padR) / n * 0.62);
      const fmt = v => v.toFixed(pair.dec);
      // 直近の座標変換を保存(クリック位置→価格/バー番号の逆変換用)
      this.t = { start, end, n, hi, lo, w, h, padR, padT, padB };

      // グリッド + 価格軸
      ctx.font = '10px IBM Plex Mono, monospace';
      ctx.textAlign = 'left';
      for (let i = 0; i <= 6; i++) {
        const p = lo + (hi - lo) * i / 6, y = Y(p);
        ctx.strokeStyle = C.grid;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w - padR, y); ctx.stroke();
        ctx.fillStyle = C.muted;
        ctx.fillText(fmt(p), w - padR + 8, y + 3);
      }

      // 移動平均(SMA / EMA は kind で指定)
      if (o.smaCtx && o.smas) {
        for (const s of o.smas) {
          ctx.strokeStyle = s.color; ctx.lineWidth = 1.4;
          ctx.beginPath();
          let started = false;
          for (let i = start; i < end; i++) {
            const v = s.kind === 'ema' ? o.smaCtx.ema(s.period, i) : o.smaCtx.sma(s.period, i);
            if (v == null) continue;
            const x = X(i), y = Y(v);
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          }
          ctx.stroke(); ctx.lineWidth = 1;
        }
      }

      // ローソク足
      for (let i = start; i < end; i++) {
        const b = candles[i], x = X(i), up = b.c >= b.o;
        const col = up ? C.up : C.down;
        ctx.strokeStyle = col; ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(x, Y(b.h)); ctx.lineTo(x, Y(b.l)); ctx.stroke();
        const yO = Y(b.o), yC = Y(b.c);
        const top = Math.min(yO, yC), hh = Math.max(1, Math.abs(yO - yC));
        if (up) {
          ctx.fillStyle = 'rgba(45,212,167,.25)';
          ctx.fillRect(x - cw / 2, top, cw, hh);
          ctx.strokeRect(x - cw / 2, top, cw, hh);
        } else {
          ctx.fillRect(x - cw / 2, top, cw, hh);
        }
      }

      // 売買マーカー(自動検証結果)
      if (o.markers) {
        for (const t of o.markers) {
          const inView = (i) => i >= start && i < end;
          // エントリー→決済の接続線
          if (inView(t.entryIdx) || inView(t.exitIdx)) {
            ctx.strokeStyle = t.pips > 0 ? 'rgba(45,212,167,.5)' : 'rgba(240,89,106,.5)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(X(t.entryIdx), Y(t.entry));
            ctx.lineTo(X(t.exitIdx), Y(t.exit));
            ctx.stroke();
            ctx.setLineDash([]);
          }
          if (inView(t.entryIdx)) this._triangle(X(t.entryIdx), Y(t.entry), t.dir, t.dir > 0 ? C.up : C.down);
          if (inView(t.exitIdx)) this._cross(X(t.exitIdx), Y(t.exit), t.pips > 0 ? C.up : C.down);
        }
      }

      // 水平線(手動モードのIN/SL/TP)
      const hline = (p, color, label, dash) => {
        const y = Y(p);
        ctx.strokeStyle = color; ctx.setLineDash(dash || []);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w - padR, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.fillRect(w - padR, y - 8, padR, 16);
        ctx.fillStyle = C.bg; ctx.textAlign = 'left';
        ctx.fillText(label + ' ' + fmt(p), w - padR + 4, y + 3);
      };
      (o.hlines || []).forEach(l => hline(l.price, l.color, l.label, l.dash));

      // 現在値
      if (o.lastPrice != null) {
        const yc = Y(o.lastPrice);
        ctx.fillStyle = C.accent;
        ctx.fillRect(w - padR, yc - 8, padR, 16);
        ctx.fillStyle = C.bg;
        ctx.fillText(fmt(o.lastPrice), w - padR + 4, yc + 3);
      }

      // ユーザー描画(水平線・トレンドライン)。トレンドラインは2点目から先へ延長(レイ)
      const drawObj = (d, preview) => {
        ctx.strokeStyle = d.color || C.amber;
        ctx.lineWidth = 1.2;
        ctx.setLineDash(preview ? [4, 4] : []);
        ctx.beginPath();
        if (d.type === 'h') {
          const y = Y(d.price);
          ctx.moveTo(0, y); ctx.lineTo(w - padR, y);
        } else if (d.type === 't') {
          const x1 = X(d.i1), y1 = Y(d.p1);
          const x2 = X(d.i2), y2 = Y(d.p2);
          ctx.moveTo(x1, y1);
          if (Math.abs(x2 - x1) > 0.5) {
            const slope = (y2 - y1) / (x2 - x1);
            const xe = x2 >= x1 ? w - padR : 0;
            ctx.lineTo(xe, y1 + slope * (xe - x1));
          } else {
            ctx.lineTo(x2, y2);
          }
        }
        ctx.stroke();
        ctx.setLineDash([]); ctx.lineWidth = 1;
      };
      (o.drawings || []).forEach(d => drawObj(d, false));
      if (o.preview) drawObj(o.preview, true);
    }

    /** キャンバスY座標→価格(直近のdraw基準) */
    priceAt(y) {
      const t = this.t;
      if (!t) return null;
      return t.hi - (y - t.padT) / (t.h - t.padT - t.padB) * (t.hi - t.lo);
    }

    /** キャンバスX座標→バー番号(直近のdraw基準) */
    indexAt(x) {
      const t = this.t;
      if (!t) return null;
      return Math.round(t.start + (x / (t.w - t.padR)) * t.n - 0.5);
    }

    _triangle(x, y, dir, color) {
      const c = this.ctx, s = 5;
      c.fillStyle = color;
      c.beginPath();
      c.moveTo(x, y + (dir > 0 ? s + 4 : -(s + 4)));
      c.lineTo(x - s, y + (dir > 0 ? s * 2 + 4 : -(s * 2 + 4)));
      c.lineTo(x + s, y + (dir > 0 ? s * 2 + 4 : -(s * 2 + 4)));
      c.closePath();
      c.fill();
    }

    _cross(x, y, color) {
      const c = this.ctx, s = 4;
      c.strokeStyle = color; c.lineWidth = 1.6;
      c.beginPath();
      c.moveTo(x - s, y - s); c.lineTo(x + s, y + s);
      c.moveTo(x + s, y - s); c.lineTo(x - s, y + s);
      c.stroke(); c.lineWidth = 1;
    }
  }

  /* ---------- 損益カーブ ---------- */
  function drawEquity(canvas, equity, startBal) {
    const { w, h } = sizeCanvas(canvas);
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, w, h);
    if (!equity || equity.length < 2) {
      g.strokeStyle = 'rgba(92,168,255,.4)';
      g.beginPath(); g.moveTo(8, h / 2); g.lineTo(w - 8, h / 2); g.stroke();
      return;
    }
    let hi = Math.max(...equity), lo = Math.min(...equity);
    if (hi === lo) { hi += 1; lo -= 1; }
    const X = i => 8 + (i / (equity.length - 1)) * (w - 16);
    const Y = v => 6 + (hi - v) / (hi - lo) * (h - 12);
    const yb = Y(startBal);
    g.strokeStyle = 'rgba(125,140,161,.35)'; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(8, yb); g.lineTo(w - 8, yb); g.stroke();
    g.setLineDash([]);
    const last = equity[equity.length - 1];
    g.strokeStyle = last >= startBal ? C.up : C.down;
    g.lineWidth = 1.6;
    g.beginPath();
    equity.forEach((v, i) => { const x = X(i), y = Y(v); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke(); g.lineWidth = 1;
  }

  return { CandleChart, drawEquity, sizeCanvas, COLORS: C };
})();
