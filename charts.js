"use strict";
window.ResearchCharts = (() => {
  const C = {
    up: "#22846c",
    down: "#ba5455",
    grid: "#e6ecec",
    text: "#586d72",
    soft: "#8fa29f",
    gold: "#ae7b26",
    blue: "#6275a9",
    line: "#146e59"
  };
  const font = '10px "Cascadia Mono",Consolas,"Microsoft YaHei UI",sans-serif';
  const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
  function px(n) {
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("en-US", {
      minimumFractionDigits: n < 1 ? 4 : 2,
      maximumFractionDigits: n < 1 ? 6 : n < 10 ? 4 : 2
    });
  }
  function fmtDate(ms, hour = false) {
    const d = new Date(ms);
    return d
      .toISOString()
      .slice(0, hour ? 16 : 10)
      .replace("T", " ");
  }
  function surface(canvas) {
    const box = canvas.getBoundingClientRect();
    if (box.width < 3 || box.height < 3) return null;
    const scale = Math.min(2, window.devicePixelRatio || 1),
      w = box.width,
      h = box.height;
    if (canvas.width !== Math.round(w * scale) || canvas.height !== Math.round(h * scale)) {
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = font;
    ctx.lineCap = "butt";
    ctx.textBaseline = "middle";
    return { ctx, w, h };
  }
  function line(ctx, x, y, x2, y2, color, width = 1, dash = []) {
    ctx.beginPath();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.moveTo(x, y);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  function poly(ctx, points, color, width = 1.4, dash = []) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    let start = true;
    for (const p of points) {
      if (!p) {
        start = true;
        continue;
      }
      if (start) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
      start = false;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  function text(ctx, s, x, y, color = C.text, align = "left") {
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }
  function scaleBounds(lo, hi) {
    const spread = hi - lo || Math.abs(hi) * 0.015 || 1;
    return [lo - spread * 0.06, hi + spread * 0.08];
  }
  function avg(bars, n, step) {
    let sum = 0,
      run = 0;
    return bars.map((b, i) => {
      if (i && b.time - bars[i - 1].time > step * 1.05) {
        sum = 0;
        run = 0;
      }
      sum += b.close;
      run++;
      if (run > n) {
        sum -= bars[i - n].close;
      }
      return run >= n ? sum / n : null;
    });
  }
  class CandleChart {
    constructor(canvas, callback) {
      this.cv = canvas;
      this.cb = callback;
      this.data = [];
      this.end = 0;
      this.count = 0;
      this.hover = null;
      this.step = 86400;
      this.draw20 = true;
      this.draw60 = false;
      this.geom = null;
      this.obs = new ResizeObserver(() => this.render());
      this.obs.observe(canvas);
      canvas.addEventListener("pointerdown", (e) => {
        if (!this.geom || e.button !== 0) return;
        this.drag = { x: e.offsetX, end: this.end, from: e.pointerType };
        this.cv.setPointerCapture(e.pointerId);
        this.inspect(e.offsetX);
      });
      canvas.addEventListener("pointermove", (e) => {
        if (!this.geom) return;
        if (this.drag && Math.abs(e.offsetX - this.drag.x) > 3) {
          const g = this.geom,
            n = Math.round(((this.drag.x - e.offsetX) / (g.r - g.l)) * this.count);
          this.end = Math.max(this.count, Math.min(this.data.length, this.drag.end + n));
          this.hover = null;
          this.render();
          return;
        }
        this.inspect(e.offsetX);
      });
      const finish = () => {
        this.drag = null;
      };
      canvas.addEventListener("pointerup", finish);
      canvas.addEventListener("pointercancel", finish);
      canvas.addEventListener("pointerleave", () => {
        if (!this.drag) {
          this.hover = null;
          this.render();
        }
      });
      canvas.addEventListener(
        "wheel",
        (e) => {
          if (!this.data.length) return;
          e.preventDefault();
          this.zoom(e.deltaY < 0 ? 0.78 : 1.28, e.offsetX);
        },
        { passive: false }
      );
      canvas.addEventListener("keydown", (e) => {
        if (!this.data.length) return;
        const k = e.key;
        if (k === "ArrowUp" || k === "ArrowDown") {
          e.preventDefault();
          this.zoom(k === "ArrowUp" ? 0.8 : 1.25);
          return;
        }
        if (k === "Home") {
          e.preventDefault();
          this.reset();
          return;
        }
        if (k !== "ArrowLeft" && k !== "ArrowRight") return;
        e.preventDefault();
        const i = this.hover ?? this.end - 1;
        this.hover = Math.max(0, Math.min(this.data.length - 1, i + (k === "ArrowRight" ? 1 : -1)));
        if (this.hover >= this.end) this.end = this.hover + 1;
        if (this.hover < this.end - this.count) this.end = this.hover + this.count;
        this.render();
      });
    }
    setData(bars, step) {
      this.data = bars;
      this.step = step;
      const indicator = (n) =>
        bars.length && Object.hasOwn(bars[0], "ma" + n)
          ? bars.map((b) => b["ma" + n] ?? null)
          : avg(bars, n, step);
      this.ma20 = indicator(20);
      this.ma60 = indicator(60);
      this.reset();
    }
    reset() {
      this.end = this.data.length;
      this.count = this.end > 600 ? Math.min(200, this.end) : this.end;
      this.hover = null;
      this.render();
    }
    zoom(factor, x) {
      if (!this.data.length) return;
      const old = this.count,
        min = Math.min(this.data.length, 8);
      this.count = Math.max(min, Math.min(this.data.length, Math.round(old * factor)));
      const g = this.geom,
        frac = g && Number.isFinite(x) ? Math.max(0, Math.min(1, (x - g.l) / (g.r - g.l))) : 1;
      this.end = Math.max(
        this.count,
        Math.min(this.data.length, Math.round(this.end + (this.count - old) * (1 - frac)))
      );
      this.hover = null;
      this.render();
    }
    inspect(x) {
      if (!this.geom || !this.count) return;
      const g = this.geom,
        start = this.end - this.count;
      const target = g.t0 + ((x - g.l) / (g.r - g.l)) * (g.t1 - g.t0);
      let lo = start,
        hi = this.end - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.data[mid].time < target) lo = mid + 1;
        else hi = mid;
      }
      if (lo > start && Math.abs(this.data[lo - 1].time - target) < Math.abs(this.data[lo].time - target))
        lo--;
      this.hover = lo;
      this.render();
    }
    render() {
      const sf = surface(this.cv);
      if (!sf) return;
      this.geom = null;
      const { ctx, w, h } = sf;
      if (!this.count) {
        this.cb(null, null, 0);
        return;
      }
      const start = this.end - this.count,
        bars = this.data.slice(start, this.end),
        last = bars[bars.length - 1];
      const vol = bars.some((b) => b.volume != null && Number.isFinite(b.volume));
      const l = 5,
        r = w - (w < 500 ? 64 : 78),
        top = 10,
        end = h - 24,
        btm = vol ? Math.max(top + 40, end - h * 0.17 - 6) : end;
      const t0 = bars[0].time - this.step * 0.56,
        t1 = last.time + this.step * 0.95;
      this.geom = { l, r, t0, t1 };
      const X = (t) => l + ((t - t0) / (t1 - t0)) * (r - l);
      let low = Infinity,
        high = -Infinity;
      bars.forEach((b, j) => {
        const i = start + j;
        low = Math.min(low, b.low);
        high = Math.max(high, b.high);
        for (const v of [this.draw20 ? this.ma20[i] : null, this.draw60 ? this.ma60[i] : null])
          if (v != null) {
            low = Math.min(low, v);
            high = Math.max(high, v);
          }
      });
      const [lo, hi] = scaleBounds(low, high),
        Y = (v) => btm - ((v - lo) / (hi - lo)) * (btm - top);
      for (let i = 0; i <= 4; i++) {
        const val = lo + ((hi - lo) * i) / 4,
          yy = Y(val);
        line(ctx, l, yy, r, yy, C.grid);
        text(ctx, px(val), r + 5, yy);
      }
      const ticks = Math.min(bars.length, Math.max(2, Math.floor((r - l) / 100)));
      for (let k = 0; k < ticks; k++) {
        const i = ticks > 1 ? Math.round(((bars.length - 1) * k) / (ticks - 1)) : 0,
          b = bars[i],
          x = X(b.time);
        const sameDay = last.time - bars[0].time < 86400 && this.step < 86400;
        line(ctx, x, top, x, end, C.grid, 0.65);
        let s = fmtDate(b.time * 1000, true);
        s = sameDay
          ? s.slice(11)
          : this.step < 86400 && t1 - t0 < 4 * 86400
            ? s.slice(5, 13) + "h"
            : s.slice(2, 10);
        text(
          ctx,
          s,
          Math.max(l + 1, Math.min(r - 1, x)),
          h - 10,
          C.text,
          k === 0 ? "left" : k === ticks - 1 ? "right" : "center"
        );
      }
      const bw = Math.max(0.8, Math.min(15, ((r - l) / (t1 - t0)) * this.step * 0.65));
      let maxVol = 0;
      if (vol) for (const b of bars) maxVol = Math.max(maxVol, b.volume || 0);
      bars.forEach((b, i) => {
        const x = X(b.time),
          col = b.close >= b.open ? C.up : C.down;
        line(ctx, x, Y(b.high), x, Y(b.low), col, Math.min(1.1, bw));
        ctx.fillStyle = col;
        ctx.fillRect(
          x - bw / 2,
          Math.min(Y(b.open), Y(b.close)),
          bw,
          Math.max(1, Math.abs(Y(b.open) - Y(b.close)))
        );
        if (vol && maxVol && b.volume != null) {
          const hh = Math.max(0.5, ((end - btm - 9) * b.volume) / maxVol);
          ctx.fillStyle = b.close >= b.open ? "#a5cbbf" : "#dcb9b9";
          ctx.fillRect(x - bw / 2, end - hh, bw, hh);
        }
      });
      if (vol) {
        line(ctx, l, btm + 5, r, btm + 5, C.grid);
        text(ctx, "量 " + compact.format(maxVol), r + 4, btm + 13);
      }
      for (const [enabled, vs, col] of [
        [this.draw20, this.ma20, C.gold],
        [this.draw60, this.ma60, C.blue]
      ])
        if (enabled) {
          const points = [];
          bars.forEach((b, j) => {
            if (j && b.time - bars[j - 1].time > this.step * 1.05) points.push(null);
            points.push(vs[start + j] == null ? null : [X(b.time), Y(vs[start + j])]);
          });
          poly(ctx, points, col, 1.5);
        }
      const i =
          this.hover != null && this.hover >= start && this.hover < this.end ? this.hover : this.end - 1,
        b = this.data[i];
      if (this.hover != null) {
        line(ctx, X(b.time), top, X(b.time), end, "#68877f", 0.8, [3, 3]);
        line(ctx, l, Y(b.close), r, Y(b.close), "#809b92", 0.8, [3, 3]);
      }
      const y = Math.max(top + 8, Math.min(btm - 8, Y(b.close))),
        col = b.close >= b.open ? C.up : C.down;
      ctx.fillStyle = col;
      ctx.fillRect(r + 1, y - 7, w - r - 2, 15);
      text(ctx, px(b.close), r + 4, y + 0.5, "white");
      this.cb(b, { ma20: this.ma20[i], ma60: this.ma60[i] }, this.count);
    }
  }
  function equityGraph(canvas, current, previous) {
    const sf = surface(canvas);
    if (!sf || !current?.equity?.length) return;
    const { ctx, w, h } = sf,
      l = 8,
      r = w - 60,
      top = 14,
      bottom = h - 23,
      split = top + (bottom - top) * 0.61,
      dc = split + 25;
    const sets = [current, ...(previous ? [previous] : [])].map((run, j) => {
      const initial = Number(run.stats.initial);
      const pts = run.equity.map((p) => ({
        t: Date.parse(p.date.slice(0, 10) + "T00:00:00Z") + 86400000,
        r: p.equity / initial - 1,
        d: p.drawdown
      }));
      pts.unshift({ t: pts[0].t - 86400000, r: 0, d: 0 });
      return { pts, col: j ? C.blue : C.line, dash: j ? [4, 3] : [] };
    });
    let t0 = Infinity,
      t1 = -Infinity,
      rl = 0,
      rh = 0,
      dl = 0;
    sets.forEach((s) =>
      s.pts.forEach((p) => {
        t0 = Math.min(t0, p.t);
        t1 = Math.max(t1, p.t);
        rl = Math.min(rl, p.r);
        rh = Math.max(rh, p.r);
        dl = Math.min(dl, p.d);
      })
    );
    const [a, b] = scaleBounds(rl, rh),
      X = (t) => l + ((r - l) * (t - t0)) / (t1 - t0 || 1),
      Y = (v) => split - ((v - a) / (b - a)) * (split - top),
      Yd = (v) => dc + (bottom - dc) * (v / (dl || -0.01));
    for (let k = 0; k <= 3; k++) {
      const v = a + ((b - a) * k) / 3;
      line(ctx, l, Y(v), r, Y(v), C.grid);
      text(ctx, (v * 100).toFixed(1) + "%", r + 4, Y(v));
    }
    line(ctx, l, dc, r, dc, C.grid);
    line(ctx, l, bottom, r, bottom, C.grid);
    text(ctx, "0%", r + 4, dc);
    text(ctx, (dl * 100).toFixed(1) + "%", r + 4, bottom);
    const ticks = Math.max(2, Math.floor((r - l) / 120));
    for (let j = 0; j < ticks; j++) {
      const t = t0 + ((t1 - t0) * j) / (ticks - 1),
        xx = X(t);
      line(ctx, xx, top, xx, bottom, C.grid, 0.65);
      text(
        ctx,
        fmtDate(t).slice(2),
        xx,
        h - 9,
        C.text,
        j === 0 ? "left" : j === ticks - 1 ? "right" : "center"
      );
    }
    for (const s of sets) {
      poly(
        ctx,
        s.pts.map((p) => [X(p.t), Y(p.r)]),
        s.col,
        1.9,
        s.dash
      );
      poly(
        ctx,
        s.pts.map((p) => [X(p.t), Yd(p.d)]),
        s.col,
        1.4,
        s.dash
      );
    }
    text(ctx, "日末回撤", l + 3, split + 12, C.text);
  }
  function spark(canvas, values) {
    const sf = surface(canvas);
    if (!sf || values.length < 2) return;
    const { ctx, w, h } = sf;
    const lo = Math.min(...values),
      hi = Math.max(...values);
    const points = values.map((v, i) => [
      1 + (i / (values.length - 1)) * (w - 2),
      h - 3 - ((v - lo) / (hi - lo || 1)) * (h - 6)
    ]);
    const col = values.at(-1) >= values[0] ? C.up : C.down;
    poly(ctx, points, col, 1.55);
  }
  return { CandleChart, equityGraph, spark, px, fmtDate };
})();
