import {getMeta, getSeries} from "./data.js";
import {runBacktest} from "./simulator.js";

self.onmessage = async ({data: params}) => {
  try {
    const meta = await getMeta();
    const result = await runBacktest(params, getSeries, meta);
    result.provenance = {
      kind: "browser_simulation", source: "Binance", currency: "USDT",
      created_utc: new Date().toISOString(), through_date_utc: meta.through || meta.common.end,
      snapshot_version: meta.snapshot_version || meta.meta?.updated_utc || null
    };
    self.postMessage({result});
  } catch (e) {
    self.postMessage({error: e?.message || String(e)});
  }
};
