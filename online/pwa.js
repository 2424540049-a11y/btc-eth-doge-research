const statusText = document.querySelector("[data-offline-status]");
const saveButton = document.querySelector("[data-prepare-offline]");
const scope = new URL("../", import.meta.url);
let registration;

function render(text, label, disabled = true) {
  if (statusText) statusText.textContent = text;
  if (saveButton) {
    saveButton.textContent = label;
    saveButton.disabled = disabled;
  }
}

function applyStatus(message) {
  const { state, done, total, bytes } = message;
  if (state === "ready") {
    render("三个币种的历史行情已保存，可以断网查看行情和运行回测。", "离线数据已保存");
  } else if (state === "saving") {
    render("正在保存历史行情（" + done + " / " + total + " 个文件）。", "正在保存…");
  } else if (state === "error") {
    render("保存中断。请检查网络和设备剩余空间，重试会接着下载。", "继续保存", false);
  } else if (state === "available") {
    const mb = (bytes / 1e6).toFixed(1);
    render("完整离线回测还需下载约 " + mb + " MB 历史行情。", "保存离线数据", false);
  }
}

function query() {
  (navigator.serviceWorker?.controller || registration?.active)?.postMessage({ type: "offline-query" });
}

saveButton?.addEventListener("click", () => {
  const worker = navigator.serviceWorker?.controller || registration?.active;
  if (!worker) return;
  render("正在检查设备上已保存的行情。", "正在保存…");
  worker.postMessage({ type: "offline-save" });
});

async function start() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    render("当前浏览器环境无法保存完整离线数据。", "离线保存不可用");
    return;
  }
  render("正在准备离线功能…", "保存离线数据");
  navigator.serviceWorker.addEventListener("message", event => {
    if (event.data?.type === "offline-status" && event.source?.scriptURL === new URL("sw.js", scope).href) {
      applyStatus(event.data);
    }
  });
  navigator.serviceWorker.addEventListener("controllerchange", query);
  window.addEventListener("pageshow", query);
  document.querySelector("#install-app")?.addEventListener("click", query);
  registration = await navigator.serviceWorker.register(new URL("sw.js", scope), {
    scope: scope.href, updateViaCache: "none"
  });
  function watch(worker) {
    worker?.addEventListener("statechange", () => {
      if (worker.state === "redundant" && !registration.active)
        render("离线组件未加载成功。联网后请重新打开研究台。", "离线保存不可用");
    });
  }
  watch(registration.installing);
  registration.addEventListener("updatefound", () => watch(registration.installing));
  await navigator.serviceWorker.ready;
  query();
}

start().catch(() => render("当前未能启用离线功能，联网后请重新打开研究台。", "离线保存不可用"));
