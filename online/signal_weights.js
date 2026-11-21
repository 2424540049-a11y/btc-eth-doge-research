// Causal position targets; a closed signal bar is traded one hour after its end.
const HOUR = 3600;
const sumAbs = values => values.reduce((total, value) => total + Math.abs(value), 0);

function grossCap(weights) {
  const gross = sumAbs(weights);
  return gross > 1.5 ? weights.map(w => w * (1.5 / gross)) : weights;
}

function capDirectional(weights) {
  weights[2] = Math.max(-0.25, Math.min(0.25, weights[2]));
  return grossCap(weights);
}

function capNeutral(weights) {
  if (Math.abs(weights[2]) > 0.25) {
    const factor = 0.25 / Math.abs(weights[2]);
    weights = weights.map(w => w * factor);
  }
  return grossCap(weights);
}

function aggregate(assets, begin, end, hours) {
  const bars = [];
  const count = (end - begin) / HOUR;
  for (let i = 0; i + hours <= count; i += hours) {
    const high = [], low = [], close = [];
    for (const asset of assets) {
      let h = -Infinity, l = Infinity;
      for (let step = 0; step < hours; step++) {
        const row = asset.perp[asset.perpOffset + i + step];
        h = Math.max(h, row[2]); l = Math.min(l, row[3]);
      }
      high.push(h); low.push(l);
      close.push(asset.perp[asset.perpOffset + i + hours - 1][4]);
    }
    bars.push({time: begin + (i + hours + 1) * HOUR, high, low, close});
  }
  return bars;
}

function nextEma(previous, current, span) {
  if (previous === undefined) return current;
  const alpha = 2 / (span + 1);
  return (1 - alpha) * previous + alpha * current;
}

function emaTargets(bars, cfg) {
  const result = new Map();
  let fast, slow;
  for (let i = 0; i < bars.length; i++) {
    const close = bars[i].close[0];
    fast = nextEma(fast, close, cfg.fast_days);
    slow = nextEma(slow, close, cfg.slow_days);
    const direction = fast > slow ? 1 : (fast < slow && cfg.mode === 'long_short' ? -1 : 0);
    result.set(bars[i].time, [i + 1 >= cfg.slow_days ? direction * cfg.position_scale : 0]);
  }
  return result;
}

// Adjust=False exponential variance, with the sample-weight correction used by pandas ewm.std.
function ewVol(state, value) {
  const alpha = 2 / 31, decay = 1 - alpha;
  if (!state.count) {
    state.mean = value; state.variance = 0; state.squaredWeights = 1;
  } else {
    const delta = value - state.mean;
    state.variance = decay * (state.variance + alpha * delta * delta);
    state.mean = decay * state.mean + alpha * value;
    state.squaredWeights = decay * decay * state.squaredWeights + alpha * alpha;
  }
  state.count++;
  if (state.count < 30) return NaN;
  return Math.max(0.25, Math.sqrt(365 * state.variance / (1 - state.squaredWeights)));
}

function dailyTargets(bars, cfg) {
  const result = new Map();
  const states = [{count:0}, {count:0}, {count:0}];
  const horizons = [20,60,120], budgets = [0.5,0.35,0.15];
  const rotationOnly = cfg.strategy === 'rotation_30';
  const lookback = rotationOnly ? cfg.lookback_days : 30;
  for (let i = 0; i < bars.length; i++) {
    const {time, close} = bars[i];
    const vol = close.map((v,j) => i ? ewVol(states[j], v / bars[i-1].close[j] - 1) : NaN);
    if (i < Math.max(lookback,30)) { result.set(time,[0,0,0]); continue; }
    const change = close.map((v,j) => v / bars[i-lookback].close[j] - 1);
    const ranked = [0,1,2].sort((a,b) => change[a] - change[b] || a-b);
    const weakest = ranked[0], strongest = ranked[2];
    const rotation = capDirectional(close.map((_,j) => j===strongest && change[j]>0 ? 0.4 / vol[j] : 0));
    if (rotationOnly) {
      result.set(time, rotation.map(w => w * cfg.position_scale));
      continue;
    }
    const momentum = capDirectional(close.map((v,j) => {
      if (i < 120) return 0;
      const direction = horizons.reduce((total,n) => total + Math.sign(v / bars[i-n].close[j] - 1),0) / 3;
      return Math.max(0,direction) * 0.4 / vol[j] * budgets[j];
    }));
    const neutralScale = 0.4 / (vol.reduce((a,b) => a+b,0) / 3) / 2;
    const relative = capNeutral(close.map((_,j) => j===strongest ? neutralScale : j===weakest ? -neutralScale : 0));
    result.set(time, rotation.map((w,j) => (w + momentum[j] + relative[j]) / 3 * cfg.position_scale));
  }
  return result;
}

function fourHourTargets(bars, cfg) {
  const result = new Map(), fast = [], slow = [], positions = [0,0,0];
  const returns = [[],[],[]];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i], trend = [], breakout = [];
    for (let j = 0; j < 3; j++) {
      const c = bar.close[j];
      fast[j] = nextEma(fast[j],c,48); slow[j] = nextEma(slow[j],c,192);
      const aligned = i < 191 ? 0 : fast[j]>slow[j] && c>slow[j] ? 1 : fast[j]<slow[j] && c<slow[j] ? -1 : 0;
      if (i >= 144) {
        let enterHigh = -Infinity, enterLow = Infinity, exitHigh = -Infinity, exitLow = Infinity;
        for (let k=i-144; k<i; k++) {
          const h = bars[k].high[j], l = bars[k].low[j];
          enterHigh = Math.max(enterHigh,h); enterLow = Math.min(enterLow,l);
          if (k >= i-72) { exitHigh = Math.max(exitHigh,h); exitLow = Math.min(exitLow,l); }
        }
        if (c > enterHigh) positions[j] = 1;
        else if (c < enterLow) positions[j] = -1;
        else if ((positions[j]>0 && c<exitLow) || (positions[j]<0 && c>exitHigh)) positions[j] = 0;
      }
      const r = returns[j];
      if (i) r.push(c / bars[i-1].close[j] - 1);
      if (r.length > 120) r.shift();
      let risk = 0;
      if (r.length === 120) {
        const mean = r.reduce((a,b) => a+b,0)/120;
        const squares = r.reduce((a,b) => a + (b-mean)**2,0);
        const vol = Math.max(0.2, Math.sqrt(squares/119) * Math.sqrt(6*365));
        risk = (0.4 / 3) / vol;
      }
      trend.push(aligned*risk); breakout.push(positions[j]*risk);
    }
    const t = capDirectional(trend), b = capDirectional(breakout);
    result.set(bar.time, t.map((w,j) => (w+b[j]) * 0.25 * cfg.position_scale));
  }
  return result;
}

export function targets(assets, begin, end, cfg) {
  const four = cfg.strategy === 'four_hour_half';
  const bars = aggregate(assets,begin,end,four ? 4 : 24);
  if (four) return fourHourTargets(bars,cfg);
  return cfg.strategy === 'ema_cross' ? emaTargets(bars,cfg) : dailyTargets(bars,cfg);
}
