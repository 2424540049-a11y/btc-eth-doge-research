"use strict";
const $ = (id) => document.getElementById(id);
const icons = {
  chart: '<path d="M3 3v17h18"/><path d="M7 14l4-5 4 2 5-7"/>',
  flask: '<path d="M9 3h6m-5 0v6l-5.4 9.5a1.6 1.6 0 0 0 1.4 2.4h12a1.6 1.6 0 0 0 1.4-2.4L14 9V3M8 15h8"/>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v13c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  play: '<path d="m7 4 13 8-13 8z"/>',
  refresh: '<path d="M20 5v5h-5M4 19v-5h5M5 9a7.5 7.5 0 0 1 13-4l2 3M4 16l2 3a7.5 7.5 0 0 0 13-4"/>'
};
for (const el of document.querySelectorAll("[data-icon]"))
  el.innerHTML =
    '<svg class="ico" aria-hidden="true" viewBox="0 0 24 24">' + icons[el.dataset.icon] + "</svg>";
const markets = { perp: "永续合约", spot: "现货", mark: "标记价格", funding: "资金费率" };
const coinName = { BTC: "Bitcoin", ETH: "Ethereum", DOGE: "Dogecoin" },
  coinMark = { BTC: "₿", ETH: "◆", DOGE: "Ð" };
const titles = { market: "行情研究", backtest: "策略回测", quality: "数据管理" };
const step = { "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 },
  day = 86400000;
const nfmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? "—" : nfmt.format(Number(v)));
const price = (v) => (v == null ? "—" : ResearchCharts.px(Number(v)));
const pct = (v, d = 2, sign = false) =>
  v == null || !Number.isFinite(Number(v))
    ? "—"
    : (sign && v > 0 ? "+" : "") + (Number(v) * 100).toFixed(d) + "%";
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
const dt = (ms, full = false) => (Number.isFinite(ms) ? ResearchCharts.fmtDate(ms, full) : "—");
const utc = (date) => Date.parse(date + "T00:00:00Z");
const stamp = (v) => (v == null ? NaN : typeof v === "number" ? (v > 1e12 ? v : v * 1000) : Date.parse(v));
function show(el, value) {
  el.hidden = !value;
}
function setStatus(el, message, error = false) {
  el.textContent = message || "";
  el.classList.toggle("error", error);
  show(el, Boolean(message));
}
async function api(path, options) {
  const res = await window.onlineFetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "请求失败（" + res.status + "）");
  return body;
}
function query(path, args) {
  return path + "?" + new URLSearchParams(args).toString();
}
const state = {
  meta: null,
  page: "market",
  symbol: "BTC",
  market: "perp",
  interval: "1d",
  range: "90",
  records: "candles",
  bars: [],
  funding: null,
  query: null,
  candlesReady: false,
  recordPage: 0,
  tradePage: 0,
  gapPage: 0,
  marketRequest: 0,
  marketAbort: null,
  sparkRequest: 0,
  sparks: {},
  ohlcKey: "",
  run: null,
  previous: null,
  pendingRun: false
};
function selection(container, attr, value) {
  for (const b of container.querySelectorAll("button")) {
    const on = b.dataset[attr] === value;
    b.classList.toggle("selected", on);
    b.setAttribute("aria-pressed", String(on));
  }
}
function dateRange() {
  if (state.range === "custom") {
    const start = $("market-start").value,
      end = $("market-end").value;
    if (!start || !end || start > end) throw new Error("请选择有效的开始和结束日期。");
    return { start, end };
  }
  const stream = state.meta.coverage.find((r) => r.symbol === state.symbol && r.market === state.market);
  const last = stream ? dt(stamp(stream.last_ts)) : state.meta.common.end;
  const first = stream ? dt(stamp(stream.first_ts)) : state.meta.common.start;
  return { start: dt(Math.max(utc(first), utc(last) - (Number(state.range) - 1) * day)), end: last };
}
function setPage(page, changeHash = true) {
  if (!Object.hasOwn(titles, page)) page = "market";
  state.page = page;
  document.querySelectorAll(".page").forEach((el) => show(el, el.id === "page-" + page));
  document.querySelectorAll(".navlink").forEach((b) => {
    const on = b.dataset.page === page;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("page-title").textContent = titles[page];
  document.title = titles[page] + " · 策略研究台";
  if (changeHash && location.hash !== "#" + page) history.replaceState(null, "", "#" + page);
  requestAnimationFrame(() => {
    if (page === "market") {
      chart.render();
      drawSparks();
    }
    if (page === "backtest") renderEquity();
  });
}
document
  .querySelectorAll(".navlink")
  .forEach((b) => b.addEventListener("click", () => setPage(b.dataset.page)));
window.addEventListener("hashchange", () => setPage(location.hash.slice(1), false));
function barLabel(time) {
  return dt(time * 1000, state.interval === "1h" || state.interval === "4h");
}
function updateOhlc(b, m, count) {
  const key = [
    state.symbol,
    state.market,
    state.interval,
    b?.time,
    count,
    chart.draw20,
    chart.draw60,
    b?.close,
    state.chartOmitted
  ].join("/");
  if (key === state.ohlcKey) return;
  state.ohlcKey = key;
  if (!b) {
    $("ohlc").textContent = "";
    $("chart-count").textContent = "";
    return;
  }
  const values = [
    ["开", b.open],
    ["高", b.high],
    ["低", b.low],
    ["收", b.close]
  ];
  if (chart.draw20 && m.ma20 != null) values.push(["MA20", m.ma20]);
  if (chart.draw60 && m.ma60 != null) values.push(["MA60", m.ma60]);
  $("ohlc").innerHTML =
    '<span class="bar-date">' +
    barLabel(b.time) +
    "</span>" +
    values.map(([s, v]) => "<span>" + s + " <b>" + price(v) + "</b></span>").join("") +
    (b.shortened ? '<span class="badge warn">提前收盘 ' + dt(b.actual_close_ms, true) + "</span>" : "");
  $("chart-count").textContent =
    "当前 " +
    num(count) +
    " / " +
    num(state.bars.length) +
    " 根 · UTC" +
    (state.chartOmitted ? " · 未完整周期 " + num(state.chartOmitted) + " 个" : "");
}
const chart = new ResearchCharts.CandleChart($("market-chart"), updateOhlc);
function cardData(symbol) {
  return state.meta?.snapshots?.find((s) => s.symbol === symbol && s.market === state.market);
}
function drawSparks() {
  for (const symbol of state.meta?.symbols || []) {
    const cv = $("spark-" + symbol);
    if (cv && cv.offsetWidth) ResearchCharts.spark(cv, state.sparks[symbol] || []);
  }
}
function renderAssets() {
  const target = $("assets");
  target.replaceChildren();
  for (const s of state.meta.symbols) {
    const snap = cardData(s),
      v = snap?.change24h;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "asset" + (s === state.symbol ? " selected" : "");
    b.setAttribute("aria-pressed", String(s === state.symbol));
    b.setAttribute("aria-label", s + " " + markets[state.market]);
    b.innerHTML =
      '<span class="asset-name"><span class="coin ' +
      esc(s.toLowerCase()) +
      '">' +
      esc(coinMark[s]) +
      "</span>" +
      esc(s) +
      "<small>" +
      esc(coinName[s]) +
      '</small></span><span class="asset-price">' +
      price(snap?.close) +
      '</span><span class="asset-change ' +
      (v > 0 ? "pos" : v < 0 ? "neg" : "") +
      '">' +
      pct(v, 2, true) +
      ' <small>24h</small></span><canvas aria-label="近 30 天日线收盘走势" class="spark" id="spark-' +
      esc(s) +
      '"></canvas>';
    if (snap)
      b.title = s + " / USDT · " + markets[state.market] + " · " + dt(stamp(snap.ts), true) + " UTC 小时线";
    b.onclick = () => {
      if (s !== state.symbol) {
        state.symbol = s;
        renderAssets();
        loadMarket();
      }
    };
    target.append(b);
  }
  drawSparks();
}
async function loadSparks() {
  const seq = ++state.sparkRequest,
    market = state.market;
  state.sparks = {};
  await Promise.all(
    state.meta.symbols.map(async (symbol) => {
      const m = state.meta.coverage.find((x) => x.symbol === symbol && x.market === market);
      if (!m) return;
      const end = dt(stamp(m.last_ts)),
        start = dt(utc(end) - 29 * day);
      try {
        const data = await api(query("/api/candles", { symbol, market, interval: "1d", start, end }));
        if (seq !== state.sparkRequest) return;
        state.sparks[symbol] = data.candles.map((b) => b.close);
        const cv = $("spark-" + symbol);
        if (cv && cv.offsetWidth) ResearchCharts.spark(cv, state.sparks[symbol]);
      } catch {
        /* Price cards can remain usable without the optional sparkline. */
      }
    })
  );
}
function clearChart(message) {
  state.bars = [];
  state.chartOmitted = 0;
  state.funding = null;
  state.fundPending = false;
  state.fundError = "";
  state.candlesReady = false;
  state.ohlcKey = "";
  chart.setData([], step[state.interval]);
  $("chart-status").textContent = message;
  $("records-count").textContent = "";
  $("records-area").innerHTML = "";
  $("records-pager").innerHTML = "";
  $("export-market").disabled = true;
}
async function loadMarket() {
  if (!state.meta) return;
  const seq = ++state.marketRequest;
  state.marketAbort?.abort();
  const ctrl = new AbortController();
  state.marketAbort = ctrl;
  state.recordPage = 0;
  state.query = null;
  $("symbol-title").textContent = state.symbol + " / USDT";
  $("instrument").textContent = markets[state.market];
  clearChart("正在读取 K 线…");
  let q;
  try {
    q = { symbol: state.symbol, market: state.market, interval: state.interval, ...dateRange() };
  } catch (e) {
    $("chart-status").textContent = e.message;
    return;
  }
  state.query = q;
  if (state.range !== "custom") {
    $("market-start").value = q.start;
    $("market-end").value = q.end;
  }
  if (state.records === "funding") loadFunding();
  try {
    const data = await api(query("/api/candles", q), { signal: ctrl.signal });
    if (seq !== state.marketRequest) return;
    state.bars = data.candles;
    state.chartOmitted = Number(data.omitted_partial || 0);
    state.candlesReady = true;
    state.ohlcKey = "";
    chart.setData(state.bars, step[q.interval]);
    $("chart-status").textContent = state.bars.length ? "" : "所选区间没有完整 K 线，可调整周期或日期。";
    renderRecords();
    if (state.records === "candles") $("export-market").disabled = !state.bars.length;
  } catch (e) {
    if (seq !== state.marketRequest || e.name === "AbortError") return;
    $("chart-status").textContent = e.message;
    if (state.records === "candles")
      $("records-area").innerHTML = '<div class="table-empty">' + esc(e.message) + "</div>";
  }
}
async function loadFunding() {
  if (!state.query || state.funding || state.fundPending) {
    renderRecords();
    return;
  }
  const seq = state.marketRequest;
  state.fundPending = true;
  state.fundError = "";
  renderRecords();
  try {
    const { symbol, start, end } = state.query;
    const data = await api(query("/api/funding", { symbol, start, end }), {
      signal: state.marketAbort?.signal
    });
    if (seq !== state.marketRequest) return;
    state.funding = data.funding;
  } catch (e) {
    if (seq !== state.marketRequest || e.name === "AbortError") return;
    state.fundError = e.message;
  } finally {
    if (seq === state.marketRequest) {
      state.fundPending = false;
      renderRecords();
    }
  }
}
function table(headers, rows) {
  return (
    '<div class="scroll"><table><thead><tr>' +
    headers.map((x) => '<th scope="col">' + esc(x) + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows.map((row) => "<tr>" + row.map((c) => "<td>" + esc(c) + "</td>").join("") + "</tr>").join("") +
    "</tbody></table></div>"
  );
}
function pageRows(container, pager, headers, items, page, size, update, makeRow, empty, reverse = false) {
  const n = items.length,
    pages = Math.ceil(n / size);
  if (!n) {
    container.innerHTML = '<div class="table-empty">' + esc(empty) + "</div>";
    pager.replaceChildren();
    return;
  }
  page = Math.max(0, Math.min(page, pages - 1));
  const lo = page * size,
    hi = Math.min(n, lo + size),
    rows = [];
  for (let i = lo; i < hi; i++) rows.push(makeRow(items[reverse ? n - 1 - i : i]));
  container.innerHTML = table(headers, rows);
  pager.replaceChildren();
  const text = document.createElement("span");
  text.textContent = lo + 1 + "–" + hi + " / " + num(n);
  pager.append(text);
  if (pages > 1)
    for (const [title, target] of [
      ["上一页", page - 1],
      ["下一页", page + 1]
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = title;
      b.disabled = target < 0 || target >= pages;
      b.onclick = () => update(target);
      pager.append(b);
    }
}
function renderRecords() {
  const funding = state.records === "funding";
  selection($("records-tabs"), "record", state.records);
  const items = funding ? state.funding || [] : state.bars,
    status = funding
      ? state.fundPending
        ? "正在读取实际结算费率…"
        : state.fundError || "所选区间没有资金费结算记录。"
      : state.candlesReady
        ? "所选区间没有完整 K 线。"
        : "正在读取 K 线…";
  $("records-count").textContent = funding ? state.symbol + " 永续 · 实际结算" : "UTC 开盘时间";
  $("export-market").title = funding ? "导出当前区间的永续资金费率" : "导出选中区间和周期的全部 K 线";
  $("export-market-label").textContent = funding ? "导出资金费 CSV" : "导出 K 线 CSV";
  $("export-market").disabled = !items.length;
  const headers = funding
    ? ["结算时间（UTC）", "币种", "实际费率"]
    : ["开盘时间（UTC）", "开盘", "最高", "最低", "收盘", "区间涨跌", "成交量（币）"];
  pageRows(
    $("records-area"),
    $("records-pager"),
    headers,
    items,
    state.recordPage,
    8,
    (p) => {
      state.recordPage = p;
      renderRecords();
    },
    (v) =>
      funding
        ? [
            new Date(v.time_ms).toISOString().replace("T", " ").replace("Z", ""),
            state.symbol,
            pct(v.rate, 5, true)
          ]
        : [
            barLabel(v.time) + (v.shortened ? " · 提前收盘" : ""),
            price(v.open),
            price(v.high),
            price(v.low),
            price(v.close),
            pct(v.close / v.open - 1, 2, true),
            num(v.volume)
          ],
    status,
    true
  );
}
$("records-tabs").onclick = (e) => {
  const b = e.target.closest("button");
  if (b) {
    state.records = b.dataset.record;
    state.recordPage = 0;
    if (state.records === "funding") loadFunding();
    else renderRecords();
  }
};
$("export-market").onclick = () => {
  if (state.query) saveExport({ ...state.query, kind: state.records }, $("export-market"));
};
$("market-menu").onclick = (e) => {
  const b = e.target.closest("button");
  if (b && b.dataset.market !== state.market && state.meta) {
    state.market = b.dataset.market;
    selection($("market-menu"), "market", state.market);
    state.sparks = {};
    renderAssets();
    loadMarket();
    loadSparks();
  }
};
$("interval-menu").onclick = (e) => {
  const b = e.target.closest("button");
  if (b && b.dataset.interval !== state.interval) {
    state.interval = b.dataset.interval;
    selection($("interval-menu"), "interval", state.interval);
    loadMarket();
  }
};
$("range").onchange = () => {
  state.range = $("range").value;
  show($("custom-range"), state.range === "custom");
  if (state.range !== "custom") loadMarket();
};
$("custom-range").onsubmit = (e) => {
  e.preventDefault();
  loadMarket();
};
for (const id of ["ma20", "ma60"]) {
  $(id).parentElement.title = id.toUpperCase() + " 为当前 K 线周期的简单均线，缺口后的连续样本不足时留空。";
  $(id).onchange = () => {
    chart.draw20 = $("ma20").checked;
    chart.draw60 = $("ma60").checked;
    chart.render();
  };
}
$("zoom-in").onclick = () => chart.zoom(0.78);
$("zoom-out").onclick = () => chart.zoom(1.28);
$("reset-chart").onclick = () => chart.reset();
function post(path, payload) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}
let exportNoticeTimer;
$("close-export").onclick = () => {
  show($("export-status"), false);
  clearTimeout(exportNoticeTimer);
};
async function saveExport(args, button) {
  clearTimeout(exportNoticeTimer);
  button.disabled = true;
  show($("export-status"), true);
  $("export-status").classList.remove("error");
  $("export-message").textContent = "正在生成下载文件…";
  try {
    const r = await post("/api/save-export", args);
    $("export-message").textContent = "已发起下载，可在浏览器下载记录中查看 " + r.filename;
  } catch (e) {
    $("export-message").textContent = e.message;
    $("export-status").classList.add("error");
  } finally {
    button.disabled = false;
    exportNoticeTimer = setTimeout(() => show($("export-status"), false), 18000);
  }
}
async function listSaved(preferred) {
  const box = $("saved-runs"),
    old = preferred || box.value;
  try {
    const r = await api("/api/experiments");
    const opts = (r.experiments || []).map((v) => {
      const o = document.createElement("option");
      o.value = v.id;
      o.textContent = v.label;
      return o;
    });
    if (!opts.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "暂无已保存实验";
      opts.push(o);
    }
    box.replaceChildren(...opts);
    if (opts.some((x) => x.value === old)) box.value = old;
    $("load-saved").disabled = !box.value;
  } catch (e) {
    box.replaceChildren(new Option(e.message, ""));
    $("load-saved").disabled = true;
  }
}
$("saved-runs").onchange = () => {
  $("load-saved").disabled = !$("saved-runs").value;
};
$("save-run").onclick = async () => {
  if (!state.run?.run_id) return;
  $("save-run").disabled = true;
  try {
    const s = await post("/api/experiments", { run_id: state.run.run_id });
    await listSaved(s.id);
    setStatus($("back-status"), "已保存到此浏览器，可在实验记录中重新打开。");
  } catch (e) {
    setStatus($("back-status"), e.message, true);
  } finally {
    $("save-run").disabled = false;
  }
};
$("load-saved").onclick = async () => {
  const id = $("saved-runs").value;
  if (!id || state.pendingRun) return;
  $("load-saved").disabled = true;
  state.pendingRun = true;
  $("run-backtest").disabled = true;
  try {
    const run = await api(query("/api/experiment", { id }));
    state.previous = state.run;
    state.run = run;
    const p = run.params;
    $("strategy").value = p.strategy;
    paintStrategy();
    $("back-start").value = p.start;
    $("back-end").value = p.end;
    $("initial").value = p.initial;
    $("back-symbol").value = p.symbol || "BTC";
    $("scale").value = p.position_scale;
    $("cost").value = p.cost_multiplier;
    if (p.lookback_days) $("lookback").value = p.lookback_days;
    if (p.fast_days) $("fast-days").value = p.fast_days;
    if (p.slow_days) $("slow-days").value = p.slow_days;
    if (p.mode) $("ema-mode").value = p.mode;
    renderRun();
    setStatus($("back-status"), "已打开保存的实验。");
  } catch (e) {
    setStatus($("back-status"), e.message, true);
  } finally {
    $("load-saved").disabled = !$("saved-runs").value;
    state.pendingRun = false;
    $("run-backtest").disabled = false;
  }
};
function paintStrategy() {
  const id = $("strategy").value,
    d = state.meta?.strategies.find((s) => s.id === id),
    one = id === "spot_hold" || id === "ema_cross",
    ema = id === "ema_cross",
    rot = id === "rotation_30";
  $("back-symbol").disabled = !one;
  show($("universe"), !one);
  $("scale").disabled = id === "spot_hold";
  if (id === "spot_hold") $("scale").value = 1;
  show($("rotation-fields"), rot);
  $("lookback").disabled = !rot;
  $("lookback").required = rot;
  for (const el of document.querySelectorAll(".ema-field")) {
    show(el, ema);
    const input = el.querySelector("input,select");
    input.disabled = !ema;
    input.required = ema;
  }
  $("strategy-desc").textContent =
    (d?.description || "") + (id === "four_hour_half" ? " 倍率 1 对应既定半仓目标。" : "");
}
$("strategy").onchange = paintStrategy;
function runName(run) {
  const p = run.params,
    name = state.meta.strategies.find((s) => s.id === p.strategy)?.name || p.strategy;
  const coin = ["spot_hold", "ema_cross"].includes(p.strategy) ? " · " + p.symbol : "";
  const extra =
    p.strategy === "rotation_30"
      ? " · " + p.lookback_days + "日"
      : p.strategy === "ema_cross"
        ? " · " + p.fast_days + "/" + p.slow_days + " · " + (p.mode === "long_short" ? "多空" : "多头/现金")
        : "";
  return (
    name +
    coin +
    extra +
    " · " +
    p.start +
    " 至 " +
    p.end +
    " · " +
    num(p.initial) +
    " USDT · 成本 ×" +
    num(p.cost_multiplier) +
    " · 仓位 ×" +
    num(p.position_scale)
  );
}
function renderEquity() {
  if (!state.run || state.page !== "backtest") return;
  const prior = $("compare").checked ? state.previous : null;
  ResearchCharts.equityGraph($("equity-chart"), state.run, prior);
  $("equity-note").textContent = prior
    ? "实线为本次，虚线为上次。上次：" + runName(prior)
    : "累计净收益与日末回撤 · 按日末权益绘制";
  $("equity-caption").textContent = prior
    ? "两条曲线分别按各自初始本金归一化，并按实际 UTC 日期对齐。"
    : "下图取每日最后一小时相对历史小时净值峰值的回撤。摘要取全部小时中的最大跌幅。";
}
$("compare").onchange = renderEquity;
new ResizeObserver(renderEquity).observe($("equity-chart"));
function renderTrades() {
  const run = state.run;
  if (!run) return;
  const side = { buy: "买入", sell: "卖出" };
  pageRows(
    $("trades-area"),
    $("trades-pager"),
    ["模拟时间（UTC）", "币种", "方向", "数量（币）", "价格（USDT）", "交易成本（USDT）"],
    run.trades,
    state.tradePage,
    12,
    (p) => {
      state.tradePage = p;
      renderTrades();
    },
    (t) => [
      String(t.time)
        .replace("T", " ")
        .replace(/\+00:00|Z/g, ""),
      t.symbol,
      side[t.side] || t.side,
      Number(t.quantity).toLocaleString("en-US", { maximumFractionDigits: 8 }),
      price(t.price),
      Number(t.cost).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 5 })
    ],
    "此区间没有模拟成交。",
    true
  );
}
function renderRun() {
  const r = state.run,
    s = r.stats;
  show($("back-empty"), false);
  show($("back-results"), true);
  show($("compare-wrap"), !!state.previous);
  $("compare").checked = false;
  $("run-summary").textContent = runName(r);
  const metrics = [
    ["累计净收益", pct(s.total_return, 2, true), s.total_return],
    ["期末净值（USDT）", num(s.ending)],
    ["小时最大回撤", pct(s.max_drawdown)],
    ["净年化收益", pct(s.cagr, 2, true), s.cagr],
    ["年化波动率", pct(s.volatility)],
    ["夏普比率", s.sharpe == null ? "—" : s.sharpe.toFixed(2)],
    ["交易成本（USDT）", num(s.cost)],
    ["净付资金费（USDT）", num(s.funding_paid)]
  ];
  $("metrics").innerHTML = metrics
    .map(
      ([k, v, dir]) =>
        '<div class="metric"><small>' +
        esc(k) +
        '</small><strong class="' +
        (dir > 0 ? "pos" : dir < 0 ? "neg" : "") +
        '">' +
        esc(v) +
        "</strong></div>"
    )
    .join("");
  const notes = [
    ...(r.notes || []),
    "区间含 " +
      num(s.days) +
      " 个 UTC 日，共 " +
      num(s.trade_count) +
      " 笔模拟成交。模型清算标记 " +
      num(s.liquidations) +
      " 次。",
    ...(s.cagr == null ? ["不足 90 天的样本不展示年化收益、年化波动率与夏普比率。"] : [])
  ];
  $("run-notes").replaceChildren(
    ...notes.map((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      return li;
    })
  );
  state.tradePage = 0;
  renderTrades();
  requestAnimationFrame(renderEquity);
}
$("back-form").onsubmit = async (e) => {
  e.preventDefault();
  if (state.pendingRun || !state.meta) return;
  const p = {
    strategy: $("strategy").value,
    symbol: $("back-symbol").value,
    start: $("back-start").value,
    end: $("back-end").value,
    initial: Number($("initial").value),
    cost_multiplier: Number($("cost").value),
    position_scale: Number($("scale").value)
  };
  if (p.start > p.end) {
    setStatus($("back-status"), "开始日期应早于或等于结束日期。", true);
    return;
  }
  if (p.strategy === "ema_cross") {
    Object.assign(p, {
      fast_days: Number($("fast-days").value),
      slow_days: Number($("slow-days").value),
      mode: $("ema-mode").value
    });
    if (p.fast_days >= p.slow_days) {
      setStatus($("back-status"), "快速 EMA 天数应小于慢速 EMA 天数。", true);
      return;
    }
  }
  if (p.strategy === "rotation_30") p.lookback_days = Number($("lookback").value);
  state.pendingRun = true;
  $("run-backtest").disabled = true;
  setStatus($("back-status"), "正在浏览器中加载行情，逐小时回放并核算成本和资金费…");
  try {
    const r = await api("/api/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p)
    });
    state.previous = state.run;
    state.run = r;
    renderRun();
    setStatus($("back-status"), "");
  } catch (err) {
    setStatus($("back-status"), err.message + (state.run ? " 下方保留上一次成功的结果。" : ""), true);
  } finally {
    state.pendingRun = false;
    $("run-backtest").disabled = false;
  }
};
for (const kind of ["run", "trades", "equity"]) {
  const b = $("export-" + kind);
  b.onclick = () => {
    if (state.run?.run_id) saveExport({ kind, run_id: state.run.run_id }, b);
  };
}
function renderQuality() {
  const m = state.meta;
  if (!m) return;
  const rows = m.coverage.map((r) => [
    r.symbol,
    markets[r.market] || r.market,
    dt(stamp(r.first_ts), true),
    dt(stamp(r.last_ts), true),
    num(r.row_count),
    r.market === "funding" ? "—" : num(r.missing_hours)
  ]);
  $("quality-area").innerHTML = table(
    ["币种", "数据类型", "首条记录（UTC）", "末条记录（UTC）", "记录数", "缺失小时"],
    rows
  );
  const g = m.gaps ?? [];
  $("gaps-count").textContent = num(g.length) + " 段";
  pageRows(
    $("gaps-area"),
    $("gaps-pager"),
    ["币种", "数据类型", "首个缺失小时（UTC）", "结束时刻（不含，UTC）", "缺失小时"],
    g,
    state.gapPage,
    12,
    (p) => {
      state.gapPage = p;
      renderQuality();
    },
    (r) => [
      r.symbol,
      markets[r.market] || r.market,
      dt(stamp(r.start_ts), true),
      dt(stamp(r.end_ts), true),
      num(r.missing_hours)
    ],
    "已审核区间未记录价格缺口。"
  );
  const short = m.shortened || [],
    fg = m.funding_gaps || [];
  $("shortened-title").textContent = "提前收盘的小时 K 线（" + num(short.length) + " 根）";
  $("fundgap-title").textContent = "资金费结算间隔异常（" + num(fg.length) + " 段）";
  pageRows(
    $("shortened-area"),
    $("shortened-pager"),
    ["币种", "市场", "开盘（UTC）", "实际收盘（UTC）"],
    short,
    state.shortPage || 0,
    10,
    (p) => {
      state.shortPage = p;
      renderQuality();
    },
    (r) => [
      r.symbol,
      markets[r.market] || r.market,
      dt(stamp(r.ts), true),
      new Date(r.actual_close_ms).toISOString().replace("T", " ").replace("Z", "")
    ],
    "未记录提前收盘。"
  );
  pageRows(
    $("fundgap-area"),
    $("fundgap-pager"),
    ["币种", "上次结算（UTC）", "下次结算（UTC）"],
    fg,
    state.fundgapPage || 0,
    10,
    (p) => {
      state.fundgapPage = p;
      renderQuality();
    },
    (r) => [r.symbol, dt(Number(r.previous_ts_ms), true), dt(Number(r.next_ts_ms), true)],
    "未记录结算间隔异常。"
  );
}
$("update").onclick = async () => {
  const button = $("update");
  button.disabled = true;
  const previous = state.meta;
  setStatus($("update-status"), "正在检查网站上发布的行情版本…");
  try {
    const next = await api("/api/meta?refresh=1");
    const version = (m) => m?.version || m?.meta?.updated_utc || m?.common?.end;
    await loadMeta(false, next);
    const label = version(previous) === version(next) ? "当前为最新发布的快照" : "已载入新发布的快照";
    setStatus($("update-status"), label + "，数据截至 " + next.common.end + " UTC。");
  } catch (e) {
    setStatus($("update-status"), e.message, true);
  } finally {
    button.disabled = false;
  }
};
async function loadMeta(first, refreshed) {
  try {
    const meta = refreshed || await api("/api/meta");
    state.meta = meta;
    show($("init-status"), false);
    show($("global-error"), false);
    const latest = Math.max(...meta.snapshots.map((x) => stamp(x.ts)).filter(Number.isFinite));
    $("asof").textContent = Number.isFinite(latest)
      ? "快照截至 " + dt(latest, true) + " UTC"
      : "快照截至 " + meta.common.end + " UTC";
    const lastSelection = $("strategy").value;
    $("strategy").replaceChildren(
      ...meta.strategies.map((s) => {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = s.name;
        return opt;
      })
    );
    $("strategy").value = meta.strategies.some((s) => s.id === lastSelection)
      ? lastSelection
      : meta.strategies.find((s) => s.id === "daily_balanced")?.id || meta.strategies[0]?.id || "";
    if (first) {
      const finish = meta.common.end;
      $("back-end").value = finish;
      $("back-start").value = dt(Math.max(utc(meta.common.start), utc(finish) - 364 * day));
    }
    paintStrategy();
    renderQuality();
    renderAssets();
    loadMarket();
    loadSparks();
    if (first) {
      setStatus($("update-status"), "此网站按发布版本提供历史数据，当前覆盖至 " + meta.common.end + " UTC。");
      listSaved();
    }
  } catch (e) {
    show($("init-status"), false);
    setStatus($("global-error"), e.message, true);
    const b = document.createElement("button");
    b.textContent = "重新读取";
    b.className = "btn compact";
    b.onclick = () => loadMeta(first);
    $("global-error").append(b);
  }
}
setPage(location.hash.slice(1), false);
loadMeta(true);
