import {targets} from './signal_weights.js';

const HOUR = 3600, DAY = 86400;
const COINS = ['BTC','ETH','DOGE'];
const SLIP = {BTC:0.0002, ETH:0.0003, DOGE:0.0006};
const RULES = new Set(['daily_balanced','four_hour_half','rotation_30','ema_cross','spot_hold']);
const iso = s => new Date(s*1000).toISOString().replace('.000Z','+00:00');
const dayString = s => new Date(s*1000).toISOString().slice(0,10);
const dayCeil = s => Math.ceil(s/DAY)*DAY;
const dayFloor = s => Math.floor(s/DAY)*DAY;

function num(v,name,lo,hi,integer=false) {
  if (!['number','string'].includes(typeof v) || (typeof v==='string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v.trim()))) throw Error(name+'必须为数值。');
  const n = Number(v);
  if (!Number.isFinite(n) || n<lo || n>hi || (integer && !Number.isInteger(n))) {
    throw Error(name+'须介于 '+lo+' 与 '+hi+(integer?'，并为整数。':'。'));
  }
  return n;
}

function parseDate(v) {
  if (typeof v!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw Error('日期使用 YYYY-MM-DD。');
  const seconds=Date.parse(v+'T00:00:00Z')/1000;
  if (!Number.isFinite(seconds) || dayString(seconds)!==v || v<'2009-01-01' || v>='2200-01-01') throw Error('日期无效。');
  return seconds;
}

function settings(p) {
  if (!p || !RULES.has(p.strategy)) throw Error('请从策略列表选择一个回测策略。');
  const start=parseDate(p.start), end=parseDate(p.end)+DAY;
  if (start>=end) throw Error('开始日期不能晚于结束日期。');
  const single=p.strategy==='spot_hold' || p.strategy==='ema_cross';
  const field=(key,fallback)=>p[key]===undefined?fallback:p[key];
  const cfg={strategy:p.strategy,symbol:single?String(field('symbol','BTC')).toUpperCase():null,
    start:p.start,end:p.end,initial:num(field('initial',10000),'初始资金',100,1e9),
    cost_multiplier:num(field('cost_multiplier',1),'成交成本倍数',0,10),
    position_scale:num(field('position_scale',1),'目标仓位倍数',0.1,4)};
  if (single && !COINS.includes(cfg.symbol)) throw Error('请选择 BTC、ETH 或 DOGE。');
  if (cfg.strategy==='spot_hold' && cfg.position_scale!==1) throw Error('现货持有的目标仓位倍数固定为 1。');
  if (cfg.strategy==='rotation_30') cfg.lookback_days=num(field('lookback_days',30),'动量窗口',10,180,true);
  if (cfg.strategy==='ema_cross') {
    cfg.fast_days=num(field('fast_days',20),'快线周期',2,180,true);
    cfg.slow_days=num(field('slow_days',60),'慢线周期',2,180,true);
    if (cfg.fast_days>=cfg.slow_days) throw Error('快线周期应小于慢线周期。');
    cfg.mode=field('mode','long_cash');
    if (!['long_cash','long_short'].includes(cfg.mode)) throw Error('双均线方向模式无效。');
  }
  return {cfg,start,end};
}

function lowerBound(rows,t) {
  let lo=0, hi=rows.length;
  while (lo<hi) { const mid=(lo+hi)>>>1; if (rows[mid][0]<t) lo=mid+1; else hi=mid; }
  return lo;
}

function required(rows,symbol,kind) {
  if (!rows?.length) throw Error(symbol+' 缺少 '+kind+' 历史数据。');
  return rows;
}

function fill(t,symbol,change,price,cost,target) {
  return {time:iso(t),symbol,side:change>0?'buy':'sell',quantity:Math.abs(change),price,cost,target_weight:target};
}

function fundingLedger(asset,start,end,begin) {
  const exact=new Float64Array((end-start)/HOUR), later=new Float64Array(exact.length);
  const events=asset.funding, anchors=new Set();
  let previous=null;
  for (let i=lowerBound(events,start*1000);i<events.length && events[i][0]<end*1000;i++) {
    const [ms,rate]=events[i], h=Math.floor(ms/(HOUR*1000))*HOUR;
    if (!Number.isFinite(rate) || (previous!==null && h-previous>8*HOUR)) throw Error(asset.symbol+' 资金费结算覆盖不连续。');
    previous=h; anchors.add(h);
    const arr=ms===h*1000?exact:later;
    arr[(h-start)/HOUR]+=rate*asset.mark[asset.markOffset+(h-begin)/HOUR][1];
  }
  for (let h=start;h<end;h+=8*HOUR) if (!anchors.has(h)) throw Error(asset.symbol+' 缺少 '+iso(h)+' 的历史资金费结算锚点。');
  return {exact,later};
}

async function market(cfg,start,end,getSeries,meta) {
  const coins=cfg.strategy==='ema_cross'?[cfg.symbol]:COINS;
  const assets=await Promise.all(coins.map(async symbol=>{
    const [perp,mark,funding]=await Promise.all([getSeries(symbol,'perp',-Infinity,end),
      getSeries(symbol,'mark',-Infinity,end),getSeries(symbol,'funding',start*1000,end*1000)]);
    return {symbol,perp:required(perp,symbol,'永续'),mark:required(mark,symbol,'标记价'),funding:required(funding,symbol,'资金费')};
  }));
  let begin=0, last=Infinity;
  for (const asset of assets) {
    for (const kind of ['perp','mark']) {
      const rows=asset[kind];
      begin=Math.max(begin,dayCeil(rows[0][0]));
      last=Math.min(last,dayFloor(rows.at(-1)[0]+HOUR));
      for (let i=1;i<rows.length && rows[i-1][0]+HOUR<end;i++) {
        if (rows[i][0]!==rows[i-1][0]+HOUR) {
          if (rows[i][0]>start) throw Error(asset.symbol+' '+kind+' 回测时段缺少连续小时行情。');
          begin=Math.max(begin,dayCeil(rows[i][0]));
        }
      }
      for (const sh of meta.shortened ?? []) if (sh.symbol===asset.symbol && sh.market===kind && sh.ts<end) {
        if (sh.ts>=start) throw Error(asset.symbol+' '+kind+' 回测时段含提前收盘小时。');
        begin=Math.max(begin,dayCeil(sh.ts+HOUR));
      }
    }
  }
  const warm={daily_balanced:121,four_hour_half:32,ema_cross:cfg.slow_days,rotation_30:Math.max(30,cfg.lookback_days??30)+1}[cfg.strategy];
  if (start<begin+warm*DAY || end>last) throw Error('按指标的 '+warm+' 天预热，可选 '+dayString(begin+warm*DAY)+' 至 '+dayString(last-DAY)+'。');
  for (const asset of assets) {
    for (const kind of ['perp','mark']) {
      const rows=asset[kind], offset=lowerBound(rows,begin);
      if (rows[offset]?.[0]!==begin || rows[offset+(end-begin)/HOUR-1]?.[0]!==end-HOUR) throw Error(asset.symbol+' '+kind+' 行情缺失。');
      asset[kind+'Offset']=offset;
    }
    Object.assign(asset,fundingLedger(asset,start,end,begin));
  }
  return {begin,assets};
}

async function spot(cfg,start,end,getSeries,meta) {
  const rows=required(await getSeries(cfg.symbol,'spot'),cfg.symbol,'现货');
  if (start<dayCeil(rows[0][0]) || end>dayFloor(rows.at(-1)[0]+HOUR)) throw Error('所选日期超出现货完整日覆盖。');
  const buyAt=start+HOUR, sellAt=end-HOUR;
  const shortened=(meta.shortened ?? []).filter(s=>s.symbol===cfg.symbol && s.market==='spot' && s.ts>=start && s.ts<end);
  if (shortened.some(s=>s.ts===buyAt || s.ts===sellAt)) throw Error('开仓或平仓所在小时提前收盘，请调整日期。');
  const openRow=rows[lowerBound(rows,buyAt)],closeRow=rows[lowerBound(rows,sellAt)];
  if (openRow?.[0]!==buyAt || closeRow?.[0]!==sellAt) throw Error('开仓或平仓所在小时缺少实际成交价。');
  const rate=(0.001+SLIP[cfg.symbol])*cfg.cost_multiplier;
  const buy=openRow[1], sell=closeRow[4], qty=cfg.initial/(buy*(1+rate));
  const openFee=qty*buy*rate, closeFee=qty*sell*rate;
  const trades=[fill(buyAt,cfg.symbol,qty,buy,openFee,1),fill(end-1,cfg.symbol,-qty,sell,closeFee,0)];
  const equity=new Float64Array((end-start)/HOUR);
  let cursor=lowerBound(rows,start), lastClose=NaN, missing=0;
  for (let t=start,i=0;t<end;t+=HOUR,i++) {
    if (rows[cursor]?.[0]===t) lastClose=rows[cursor++][4]; else missing++;
    equity[i]=i===0?cfg.initial:qty*lastClose;
  }
  equity[equity.length-1]=qty*sell*(1-rate);
  const notes=['现货每边手续费 10 基点，BTC、ETH、DOGE 另计 2、3、6 基点滑点。首日 UTC 01:00 买入，期末按收盘价卖出。'];
  if (missing) notes.push('窗口内缺少 '+missing+' 根现货小时线，持仓估值使用此前收盘价，买卖两端使用实际行情。');
  if (shortened.length) notes.push(shortened.length+' 根现货小时线提前收盘，估值采用该时段最后实际收盘。');
  return {equity,trades,cost:openFee+closeFee,funding:0,liquidations:0,notes};
}

function perpetualLedger(cfg,start,end,begin,assets,weights) {
  const n=assets.length, quantity=Array(n).fill(0), trades=[];
  const fee=assets.map(a=>(0.0005+SLIP[a.symbol])*cfg.cost_multiplier);
  const equity=new Float64Array((end-start)/HOUR);
  const previous=assets.map(a=>a.perp[a.perpOffset+(start-begin)/HOUR][1]);
  let capital=cfg.initial, cost=0, funding=0, liquidations=0, halted=false;
  for (let t=start,i=0;t<end;t+=HOUR,i++) {
    const k=(t-begin)/HOUR;
    const price=assets.map(a=>a.perp[a.perpOffset+k]);
    const mark=assets.map(a=>a.mark[a.markOffset+k]);
    let move=0, preFunding=0, markPnl=0, markNotional=0;
    for (let j=0;j<n;j++) {
      move+=quantity[j]*(price[j][1]-previous[j]);
      preFunding+=quantity[j]*assets[j].exact[i];
      markPnl+=quantity[j]*(mark[j][1]-price[j][1]);
      markNotional+=Math.abs(quantity[j]*mark[j][1]);
    }
    capital+=move;
    capital-=preFunding;
    funding+=preFunding;
    const liquidate=(time,prices,value,notional)=>{
      for (let j=0;j<n;j++) if (quantity[j]!==0) {
        trades.push(fill(time,assets[j].symbol,-quantity[j],prices[j],Math.abs(quantity[j]*prices[j])*0.01,0));
        quantity[j]=0;
      }
      cost+=0.01*notional;
      capital=Math.max(0,value-0.01*notional);
      liquidations++; halted=true;
    };
    if (!halted && markNotional>0 && capital+markPnl<=0.01*markNotional) {
      liquidate(t,mark.map(row=>row[1]),capital+markPnl,markNotional);
    }
    const target=weights.get(t);
    if (!halted && target) {
      if (capital<=0) { quantity.fill(0); capital=0; halted=true; liquidations++; }
      else {
        let charged=0;
        for (let j=0;j<n;j++) {
          const p=price[j][1], q=quantity[j], w=target[j];
          if (Math.abs(w-q*p/capital)>=0.025 || (w===0 && q!==0) || (w!==0 && q===0)) {
            const desired=w*capital/p, change=desired-q, debit=Math.abs(change)*p*fee[j];
            charged+=debit;
            if (Math.abs(change)>1e-14) trades.push(fill(t,assets[j].symbol,change,p,debit,w));
            quantity[j]=desired;
          }
        }
        capital-=charged; cost+=charged;
      }
    }
    let later=0,worstPnl=0,worstNotional=0,closingPnl=0;
    const worst=[];
    for (let j=0;j<n;j++) {
      const q=quantity[j], p=price[j][1], adverse=q>=0?mark[j][3]:mark[j][2];
      later+=q*assets[j].later[i];
      worstPnl+=q*(adverse-p); worstNotional+=Math.abs(q*adverse);
      closingPnl+=q*(price[j][4]-p);
      worst.push(adverse); previous[j]=p;
    }
    capital-=later; funding+=later;
    if (!halted && worstNotional>0 && capital+worstPnl<=0.01*worstNotional) {
      liquidate(t+59*60,worst,capital+worstPnl,worstNotional);
      closingPnl=0;
    }
    equity[i]=capital+closingPnl;
    if (t===end-HOUR) {
      for (let j=0;j<n;j++) if (quantity[j]!==0) {
        const p=price[j][4], debit=Math.abs(quantity[j]*p)*fee[j];
        trades.push(fill(end-1,assets[j].symbol,-quantity[j],p,debit,0));
        equity[i]-=debit; cost+=debit;
      }
    }
  }
  const notes=['每边永续手续费 5 基点，BTC、ETH、DOGE 另计 2、3、6 基点滑点。资金费按真实结算事件及当时仓位核算，期末模拟平仓收费。',
    '调仓带为 2.5 个百分点。简化保证金模型采用 1% 维持保证金、1% 清算费用和小时不利标记价。',
    '价格指标从 '+dayString(begin)+' 的连续完整行情预热。'];
  if (cfg.strategy==='ema_cross') notes.push(cfg.symbol+' 单币 '+cfg.fast_days+' / '+cfg.slow_days+' 日 EMA，下一日 UTC 01:00 执行。');
  if (cfg.strategy==='rotation_30') notes.push('轮动涨幅窗口为 '+cfg.lookback_days+' 个完整日，UTC 01:00 调整。');
  return {equity,trades,cost,funding,liquidations,notes};
}

function summarize(cfg,start,ledger) {
  const daily=[],returns=[],initial=cfg.initial,notes=ledger.notes;
  let peak=initial,ddMin=0,last=initial;
  for (let i=0;i<ledger.equity.length;i++) {
    const v=ledger.equity[i];
    if (!Number.isFinite(v)) throw Error('净值包含无效数字，无法生成结果。');
    peak=Math.max(peak,v);
    const dd=v/peak-1;
    ddMin=Math.min(ddMin,dd);
    if (i%24===23) {
      daily.push({date:dayString(start+i*HOUR),equity:v,drawdown:dd});
      returns.push(last===0?0:v/last-1);
      last=v;
    }
  }
  const days=daily.length,ending=last;
  let cagr=null,volatility=null,sharpe=null;
  if (days>=90) {
    const mean=returns.reduce((a,b)=>a+b,0)/days;
    const std=Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/(days-1));
    volatility=std*Math.sqrt(365); sharpe=std?mean*Math.sqrt(365)/std:null;
    cagr=ending>0?(ending/initial)**(365/days)-1:-1;
  } else notes.push('区间少于 90 天，年化指标留空。');
  if (ledger.liquidations) notes.push('本次模拟触发保证金清算条件。');
  notes.push('最大回撤按小时收盘净值计算，曲线展示逐日收盘。');
  return {params:cfg,stats:{initial,ending,total_return:ending/initial-1,max_drawdown:ddMin,days,cagr,volatility,sharpe,
    cost:ledger.cost,funding_paid:ledger.funding,trade_count:ledger.trades.length,liquidations:ledger.liquidations},equity:daily,trades:ledger.trades,notes};
}

/** getSeries returns sorted hourly [seconds,o,h,l,c,volume] or funding [milliseconds,rate]. */
export async function runBacktest(parameters,getSeries,metadata={}) {
  const {cfg,start,end}=settings(parameters);
  if (cfg.strategy==='spot_hold') return summarize(cfg,start,await spot(cfg,start,end,getSeries,metadata));
  const {begin,assets}=await market(cfg,start,end,getSeries,metadata);
  const weights=targets(assets,begin,end,cfg);
  return summarize(cfg,start,perpetualLedger(cfg,start,end,begin,assets,weights));
}
