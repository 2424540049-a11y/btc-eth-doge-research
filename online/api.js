import {getMeta, getCandles, getFunding} from "./data.js";

const recent = new Map();
const site = new URL("../", import.meta.url);
const storageName = "research-desk-experiments:" + site.pathname;
const refs = new Map([
  ["reference-daily_balanced", {file:"daily_balanced.json", label:"参考 · 日线均衡 | 2025-01-01 至 2026-10-27 | 净收益 +20.20%"}],
  ["reference-four_hour_half", {file:"four_hour_half.json", label:"参考 · 4 小时半仓 | 2025-01-01 至 2026-10-27 | 净收益 +24.83%"}]
]);
let openDatabase;
let running = false;

function db() {
  if (!openDatabase) {
    openDatabase = new Promise((resolve,reject) => {
      const req = indexedDB.open(storageName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("runs", {keyPath:"run_id"});
      req.onerror = () => reject(new Error("浏览器没有允许保存实验，请导出 JSON 留存。"));
      req.onsuccess = () => resolve(req.result);
    }).catch(err => {openDatabase = undefined; throw err;});
  }
  return openDatabase;
}

async function transact(mode, useStore) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction("runs", mode);
    const req = useStore(tx.objectStore("runs"));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(new Error("浏览器存储操作失败，请检查存储空间或导出实验。"));
  });
}

function cacheRun(record) {
  recent.set(record.run_id, record);
  if (recent.size > 12) recent.delete(recent.keys().next().value);
  return record;
}

async function loadRun(id) {
  if (recent.has(id)) return recent.get(id);
  if (refs.has(id)) {
    const r = await fetch(new URL("reference/"+refs.get(id).file, site));
    if (!r.ok) throw new Error("无法载入参考实验，请刷新后重试。");
    return cacheRun(await r.json());
  }
  const saved = await transact("readonly", s => s.get(id));
  if (!saved) throw new Error("找不到这份实验，请重新运行或从当前浏览器打开已保存的记录。");
  return cacheRun(saved.record);
}

async function listRuns() {
  // Cursor keys and labels suffice; do not retain a second copy of all historical ledgers.
  let local = [];
  try {
    const conn = await db();
    local = await new Promise((resolve,reject) => {
      const rows = [];
      const tx = conn.transaction("runs","readonly");
      const req = tx.objectStore("runs").openCursor();
      req.onsuccess = () => {
        const c=req.result;
        if (!c) return;
        rows.push({id:c.key,label:c.value.label,created_utc:c.value.created_utc});
        c.continue();
      };
      tx.oncomplete = () => resolve(rows.sort((a,b) => b.created_utc.localeCompare(a.created_utc)));
      tx.onerror=tx.onabort=() => reject(tx.error);
    });
  } catch { /* Published reference runs remain available in storage-restricted browsers. */ }
  return {experiments:[...local,...[...refs].map(([id,ref])=>({id,label:ref.label,reference:true}))]};
}

async function saveRun(id) {
  if (refs.has(id)) return {id,label:refs.get(id).label};
  const record = await loadRun(id), meta=await getMeta();
  const p=record.params, title=meta.strategies.find(s=>s.id===p.strategy)?.name || p.strategy;
  const change=record.stats.total_return*100;
  const label=title+(p.symbol?" · "+p.symbol:"")+" | "+p.start+" 至 "+p.end+" | 净收益 "+(change>=0?"+":"")+change.toFixed(2)+"%";
  await transact("readwrite", s=>s.put({run_id:id,label,created_utc:record.provenance.created_utc,record}));
  return {id,label};
}

async function simulate(params,signal) {
  if (running) throw new Error("已有回测正在执行。");
  signal?.throwIfAborted();
  const worker = new Worker(new URL("./worker.js",import.meta.url), {type:"module"});
  running=true;
  let abort;
  try {
    const result=await new Promise((resolve,reject)=>{
      abort=()=>reject(new DOMException("已取消","AbortError"));
      signal?.addEventListener("abort",abort,{once:true});
      worker.onmessage=({data})=>data.error ? reject(new Error(data.error)) : resolve(data.result);
      worker.onerror=()=>reject(new Error("回测计算未能启动。请检查网络、浏览器版本和可用内存，再重试。"));
      worker.postMessage(params);
    });
    result.run_id="run-"+crypto.randomUUID();
    return cacheRun(result);
  } finally {
    signal?.removeEventListener("abort",abort);
    worker.terminate();
    running=false;
  }
}

function csv(fields,rows) {
  const quote=v=>v==null?"":'"'+String(v).replaceAll('"','""')+'"';
  return "\ufeff"+[fields.map(quote).join(","),...rows.map(row=>fields.map(f=>quote(row[f])).join(","))].join("\r\n")+"\r\n";
}

async function exportFile(p) {
  let text, name, mime="text/csv;charset=utf-8";
  if (p.kind==="candles") {
    const data=await getCandles(p);
    const rows=data.candles.map(r=>({...r,timestamp_utc:new Date(r.time*1000).toISOString(),symbol:p.symbol,market:p.market,interval:p.interval,
      shortened:r.shortened?1:0,actual_close_utc:r.actual_close_ms?new Date(r.actual_close_ms).toISOString():null}));
    text=csv(["timestamp_utc","time","symbol","market","interval","open","high","low","close","volume","ma20","ma60","shortened","actual_close_utc"],rows);
    name=[p.symbol,p.market,p.interval,p.start,p.end].join("_")+".csv";
  } else if (p.kind==="funding") {
    const data=await getFunding(p);
    text=csv(["timestamp_utc","time_ms","symbol","funding_rate"],data.funding.map(r=>({timestamp_utc:new Date(r.time_ms).toISOString(),time_ms:r.time_ms,symbol:p.symbol,funding_rate:r.rate})));
    name=[p.symbol,"funding",p.start,p.end].join("_")+".csv";
  } else {
    const r=await loadRun(p.run_id);
    name=[r.params.strategy,r.params.start,r.params.end,p.kind].join("_");
    if (p.kind==="run") { text=JSON.stringify(r); mime="application/json"; name+=".json"; }
    else if (p.kind==="equity") {text=csv(["date","equity","drawdown"],r.equity); name+=".csv";}
    else if (p.kind==="trades") {text=csv(["time","symbol","side","quantity","price","cost","target_weight"],r.trades); name+=".csv";}
    else throw new Error("无法识别导出类型。");
  }
  return {text,name,mime};
}

export async function onlineFetch(path,options={}) {
  const u=new URL(path,site), q=Object.fromEntries(u.searchParams);
  const key=(options.method || "GET").toUpperCase()+" "+u.pathname;
  try {
    options.signal?.throwIfAborted();
    const body=options.body?JSON.parse(options.body):{};
    let data;
    switch (key) {
      case "GET /api/meta": data=await getMeta(q.refresh==="1"); break;
      case "GET /api/candles": data=await getCandles(q); break;
      case "GET /api/funding": data=await getFunding(q); break;
      case "POST /api/backtest": data=await simulate(body,options.signal); break;
      case "GET /api/experiments": data=await listRuns(); break;
      case "GET /api/experiment": data=await loadRun(q.id); break;
      case "POST /api/experiments": data=await saveRun(body.run_id); break;
      case "GET /api/export": {
        const file=await exportFile(q);
        return new Response(file.text,{headers:{"Content-Type":file.mime,"Content-Disposition":'attachment; filename="'+file.name+'"'}});
      }
      case "POST /api/save-export": {
        const f=await exportFile(body);
        const url=URL.createObjectURL(new Blob([f.text],{type:f.mime}));
        const a=document.createElement("a"); a.href=url; a.download=f.name; document.body.append(a); a.click(); a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),30000);
        data={filename:f.name}; break;
      }
      default: return Response.json({error:"找不到该项操作。"},{status:404});
    }
    options.signal?.throwIfAborted();
    return Response.json(data);
  } catch(e) {
    if (e.name==="AbortError") throw e;
    return Response.json({error:e.message || String(e)},{status:400});
  }
}
