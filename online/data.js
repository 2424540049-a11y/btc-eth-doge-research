// Public, same-origin market snapshots. Each immutable annual shard is loaded on demand.
const dataRoot = new URL("../data/", import.meta.url);
const HOUR = 3600;
const DAY = HOUR * 24;
const PERIODS = { "1h": HOUR, "4h": 4 * HOUR, "1d": DAY, "1w": 7 * DAY };
const resident = new Map();
const waiters = [];
let manifestPromise;
let activeDownloads = 0;

async function readBytes(url, cache) {
  if (url.protocol === "file:" && typeof process !== "undefined" && process.versions?.node) {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(url));
  }
  const response = await fetch(url, { cache });
  if (!response.ok) throw new Error("无法读取研究数据（HTTP " + response.status + "），请检查网络后重试。");
  return new Uint8Array(await response.arrayBuffer());
}

async function manifest() {
  if (!manifestPromise) {
    manifestPromise = readBytes(new URL("manifest.json", dataRoot), "no-cache").then(bytes => {
      const snapshot = JSON.parse(new TextDecoder().decode(bytes));
      if (snapshot.schema !== 1 || !snapshot.meta?.through || !snapshot.series?.BTC) {
        throw new Error("公开数据清单格式不兼容，请刷新网页。");
      }
      snapshot.meta.snapshot_version = snapshot.version;
      return snapshot;
    }).catch(err => { manifestPromise = undefined; throw err; });
  }
  return manifestPromise;
}

export async function refreshData() {
  if (globalThis.navigator?.serviceWorker?.controller) {
    const current = await manifest();
    const url = new URL("manifest.json?latest=1", dataRoot);
    const latest = JSON.parse(new TextDecoder().decode(await readBytes(url, "no-store")));
    if (latest.version !== current.version) {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
      throw new Error("网站已发布新版行情。请关闭所有研究台窗口，再重新打开以载入新版。");
    }
    return current.meta;
  }
  manifestPromise = undefined;
  return (await manifest()).meta;
}

export async function getMeta(options) {
  return options === true || options?.refresh ? refreshData() : (await manifest()).meta;
}

async function limited(task) {
  if (activeDownloads >= 5) {
    await new Promise(resolve => waiters.push(resolve));
  } else {
    activeDownloads++;
  }
  try {
    return await task();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else activeDownloads--;
  }
}

async function verify(bytes, digest) {
  if (!globalThis.crypto?.subtle) return;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(hash, n => n.toString(16).padStart(2, "0")).join("");
  if (hex !== digest) throw new Error("行情文件校验失败，请刷新网页重新读取。");
}

async function unpack(part) {
  const raw = await readBytes(new URL(part.file, dataRoot), "default");
  let bytes = raw;
  // Some web hosts send Content-Encoding: gzip; fetch will then have already decompressed the file.
  if (raw[0] === 31 && raw[1] === 139) {
    await verify(raw, part.sha256);
    if (typeof DecompressionStream !== "function") {
      throw new Error("此浏览器无法打开压缩行情文件，请用较新版本的浏览器打开。");
    }
    bytes = new Uint8Array(await new Response(
      new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"))
    ).arrayBuffer());
  } else {
    await verify(bytes, part.plain_sha256);
  }
  const rows = JSON.parse(new TextDecoder().decode(bytes));
  if (rows.length !== part.rows || rows[0][0] !== part.first || rows.at(-1)[0] !== part.last) {
    throw new Error("行情分片行数或日期范围不完整。");
  }
  return rows;
}

function cachePart(part) {
  let entry = resident.get(part.file);
  resident.delete(part.file);
  if (!entry) {
    entry = { ready: false };
    entry.result = limited(() => unpack(part)).then(rows => {
      entry.ready = true;
      if (resident.size > 20) {
        for (const [key, older] of resident) {
          if (resident.size <= 20) break;
          if (older.ready) resident.delete(key);
        }
      }
      return rows;
    }).catch(err => { resident.delete(part.file); throw err; });
  }
  resident.set(part.file, entry);
  return entry.result;
}

function lowerBound(rows, point) {
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (rows[middle][0] < point) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Ascending source rows, with optional half-open bounds in the series timestamp units.
 * Candle rows: [UTC seconds, open, high, low, close, volume|null].
 * Funding rows: [UTC milliseconds, realized funding rate].
 * Returned row values are read-only source observations.
 */
export async function getSeries(symbol, market, from = -Infinity, endExclusive = Infinity) {
  const snapshot = await manifest();
  if (!snapshot.meta.symbols.includes(symbol)) throw new Error("币种只能选择 BTC、ETH 或 DOGE。");
  if (!["spot","perp","mark","funding"].includes(market)) throw new Error("没有这个市场。");
  if (!(from < endExclusive)) return [];
  const parts = snapshot.series[symbol][market].filter(part => part.last >= from && part.first < endExclusive);
  const arrays = await Promise.all(parts.map(cachePart));
  const result = [];
  for (const rows of arrays) {
    const start = lowerBound(rows, from);
    const end = lowerBound(rows, endExclusive);
    for (let i = start; i < end; i++) result.push(rows[i]);
  }
  return result;
}

function dayStamp(input) {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new Error("日期请使用 YYYY-MM-DD 格式。");
  }
  const ms = Date.parse(input + "T00:00:00Z");
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== input) {
    throw new Error("日期无效。");
  }
  return ms / 1000;
}

function span({start, end}) {
  const begin = dayStamp(start), last = dayStamp(end);
  if (begin > last || start < "2009-01-01" || end >= "2100-01-01") {
    throw new Error("请检查日期范围，结束日期必须大于或等于开始日期。");
  }
  return [begin, last + DAY];
}

export async function getFunding(params) {
  const { symbol } = params;
  const [begin, end] = span(params);
  const source = await getSeries(symbol, "funding", begin * 1000, end * 1000);
  return { symbol, funding: source.map(([time_ms, rate]) => ({time_ms, rate})), source: "Binance", timezone: "UTC" };
}

export async function getCandles(params) {
  const { symbol, market, interval = "1d" } = params;
  const meta = await getMeta();
  if (!meta.markets.includes(market)) throw new Error("没有这个价格市场。");
  if (!meta.intervals.includes(interval)) throw new Error("周期支持 1h、4h、1d、1w。");
  const [begin, end] = span(params);
  const step = PERIODS[interval];
  const anchor = interval === "1w" ? 4*DAY : 0;
  const bucket = t => Math.floor((t-anchor)/step)*step+anchor;
  const source = await getSeries(symbol, market, bucket(begin)-60*step, end);
  const shortened = new Map(meta.shortened.filter(x => x.symbol===symbol && x.market===market)
    .map(x=>[x.ts,x.actual_close_ms]));
  const averages = [];
  const candles = [];
  let first = null, last = null, bar = null, count = 0, prior = null;
  function finish() {
    if (bar === null || count !== step/HOUR) return;
    if (bar.shortened || prior === null || bar.time !== prior + step) averages.length = 0;
    if (!bar.shortened) {
      averages.push(bar.close);
      if (averages.length>60) averages.shift();
    }
    if (bar.time >= begin && bar.time+step<=end) {
      bar.ma20 = averages.length>=20 ? averages.slice(-20).reduce((a,b)=>a+b,0)/20 : null;
      bar.ma60 = averages.length===60 ? averages.reduce((a,b)=>a+b,0)/60 : null;
      candles.push(bar);
    }
    prior = bar.time;
  }
  for (const [t, open, high, low, close, volume] of source) {
    if (t >= begin) { if (first === null) first=t; last=t; }
    if (interval !== "1h" && shortened.has(t)) continue;
    const key = bucket(t);
    if (bar === null || key !== bar.time) {
      finish();
      bar = { time:key, open, high, low, close, volume };
      if (shortened.has(t)) { bar.shortened=true; bar.actual_close_ms=shortened.get(t); }
      count=1;
    } else {
      bar.high=Math.max(bar.high,high);
      bar.low=Math.min(bar.low,low);
      bar.close=close;
      bar.volume=bar.volume===null || volume===null ? null : bar.volume+volume;
      count++;
    }
  }
  finish();
  const coverage=meta.coverage.find(r=>r.symbol===symbol && r.market===market);
  const lo=Math.max(begin,coverage.first_ts), hi=Math.min(end-HOUR,coverage.last_ts);
  const expected=hi<lo ? 0 : 1+(bucket(hi)-bucket(lo))/step;
  return { symbol, market, interval, candles, source:"Binance", timezone:"UTC", first_source_ts:first,
    last_source_ts:last, omitted_partial:Math.max(0,expected-candles.length) };
}
