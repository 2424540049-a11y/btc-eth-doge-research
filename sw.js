/* The release inventory is generated from the exact bytes published to Pages. */
importScripts("./online/release.js");

const { version, files } = self.RESEARCH_RELEASE;
const base = self.registration.scope;
const prefix = "strategy-desk:" + base + ":";
const shellName = prefix + "app:" + version;
const dataName = prefix + "market";
const urlOf = path => new URL(path, base).href;
const shellPaths = new Map(Object.keys(files).map(path => [urlOf(path), path]));
const manifestUrl = urlOf("data/manifest.json");
let inventory;
let download;
let progress;

async function checksum(buffer) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function shellFile(path) {
  const resource = new URL(path, base);
  resource.searchParams.set("release", version);
  const response = await fetch(resource, { cache: "reload" });
  if (!response.ok || await checksum(await response.clone().arrayBuffer()) !== files[path]) {
    throw new Error("应用文件未完整发布：" + path);
  }
  return response;
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(shellName);
    // Each waiting worker gets its own cache. Existing tabs finish on their current release.
    await Promise.all(Object.keys(files).map(async path => {
      await cache.put(urlOf(path), await shellFile(path));
    }));
  })());
});

function parts() {
  if (!inventory) {
    inventory = (async () => {
      const shell = await caches.open(shellName);
      const response = await shell.match(manifestUrl);
      const { series } = await response.json();
      const result = new Map();
      for (const feeds of Object.values(series)) {
        for (const part of Object.values(feeds).flat()) {
          result.set(urlOf("data/" + part.file), part);
        }
      }
      return result;
    })().catch(error => { inventory = undefined; throw error; });
  }
  return inventory;
}

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(prefix + "app:") && name !== shellName) await caches.delete(name);
    }
    const valid = await parts();
    const cache = await caches.open(dataName);
    for (const request of await cache.keys()) {
      if (!valid.has(request.url)) await cache.delete(request);
    }
    await self.clients.claim();
  })());
});

async function fromShell(path) {
  const cache = await caches.open(shellName);
  const key = urlOf(path);
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = await shellFile(path);
  await cache.put(key, response.clone());
  return response;
}

async function fetchPart(url, part) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("行情下载失败");
  const digest = await checksum(await response.clone().arrayBuffer());
  if (digest !== part.sha256 && digest !== part.plain_sha256) throw new Error("行情校验失败");
  return response;
}

async function marketResponse(request) {
  const cache = await caches.open(dataName);
  const stored = await cache.match(request);
  if (stored) return stored;
  const part = (await parts()).get(request.url);
  if (!part) return fetch(request);
  const response = await fetchPart(request.url, part);
  // Reading a chart still works online if browser storage is full.
  try { await cache.put(request, response.clone()); } catch {}
  return response;
}

async function reportRange(path, range) {
  const full = await fromShell(path);
  const bytes = await full.arrayBuffer();
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return new Response(bytes, {headers: {"Content-Type": "application/pdf"}});
  const size = bytes.byteLength;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (start > end || start >= size) return new Response(null, {status: 416, headers: {"Content-Range": "bytes */" + size}});
  return new Response(bytes.slice(start, end + 1), {status: 206, headers: {
    "Content-Type": "application/pdf", "Accept-Ranges": "bytes", "Content-Length": String(end-start+1),
    "Content-Range": "bytes " + start + "-" + end + "/" + size
  }});
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET" || !request.url.startsWith(base)) return;
  const url = new URL(request.url);
  url.hash = "";
  if (request.headers.has("range")) {
    const path = shellPaths.get(url.href);
    if (path === "basis.pdf" || path === "basis6.pdf" || path === "returns7.pdf") event.respondWith(reportRange(path, request.headers.get("range")));
    return;
  }
  if (request.mode === "navigate" && (url.pathname === new URL(base).pathname || url.pathname === new URL("index.html", base).pathname)) {
    event.respondWith(fromShell("index.html"));
    return;
  }
  const path = shellPaths.get(url.href);
  if (path) event.respondWith(fromShell(path));
  else if (url.href.startsWith(urlOf("data/")) && url.pathname.endsWith(".json.gz")) {
    event.respondWith(marketResponse(request));
  }
});

async function remainingParts() {
  const table = await parts();
  const cache = await caches.open(dataName);
  const present = new Set((await cache.keys()).map(item => item.url));
  const pending = Array.from(table).filter(([url]) => !present.has(url));
  return { pending, total: table.size, cache };
}

async function status() {
  if (progress) return progress;
  const { pending, total } = await remainingParts();
  const bytes = pending.reduce((sum, [, part]) => sum + part.bytes, 0);
  return { state: pending.length ? "available" : "ready", total, done: total - pending.length, bytes };
}

async function broadcast(value) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    if (client.url.startsWith(base)) client.postMessage({ type: "offline-status", ...value });
  }
}

async function saveAll() {
  const { pending, total, cache } = await remainingParts();
  let done = total - pending.length;
  let error;
  progress = { state: "saving", done, total };
  await broadcast(progress);
  // Bound concurrent requests and preserve completed shards for a retry.
  async function next() {
    while (pending.length && !error) {
      const [url, part] = pending.shift();
      try {
        const response = await fetchPart(url, part);
        await cache.put(url, response);
        progress = { state: "saving", done: ++done, total };
        if (done % 4 === 0) await broadcast(progress);
      } catch (cause) { error = cause; }
    }
  }
  await Promise.all(Array.from({ length: 4 }, next));
  progress = undefined;
  if (error) throw error;
  await broadcast(await status());
}

self.addEventListener("message", event => {
  if (!event.source?.url?.startsWith(base)) return;
  if (event.data?.type === "offline-query") {
    event.waitUntil(status().then(value => event.source.postMessage({ type: "offline-status", ...value })));
  } else if (event.data?.type === "offline-save") {
    if (!download) download = saveAll().catch(() => broadcast({ state: "error" })).finally(() => {
      download = undefined;
      progress = undefined;
    });
    event.waitUntil(download);
  }
});
