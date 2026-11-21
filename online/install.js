(() => {
  const entry = document.getElementById("install-app");
  const label = document.getElementById("install-label");
  const dialog = document.getElementById("install-dialog");
  const title = document.getElementById("install-title");
  const intro = document.getElementById("install-intro");
  const steps = document.getElementById("install-steps");
  const status = document.getElementById("install-status");
  const confirm = document.getElementById("install-confirm");
  const close = document.getElementById("install-close");
  const appWindow = matchMedia("(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)");
  const ua = navigator.userAgent;
  const appleMobile = /iPad|iPhone|iPod/.test(ua) || (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const edge = /Edg\//.test(ua);
  const chrome = /Chrome\//.test(ua) && !/Edg\/|OPR\/|SamsungBrowser\//.test(ua);
  const safari = /Version\/.*Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/.test(ua);
  const windows = /Windows/.test(ua);
  const mac = /Macintosh/.test(ua) && !appleMobile;
  let installPrompt = null;
  let installedHere = false;
  let waiting = false;
  let feedback = "";

  function desktopShortcut() {
    if (edge && windows) {
      return "需要桌面图标时，在 Edge 地址栏输入 edge://apps，打开策略研究台的“详细信息”，选择“创建桌面快捷方式”。";
    }
    if (chrome && !android && !/CrOS/.test(ua)) {
      return "需要桌面图标时，在 Chrome 中打开 chrome://apps，右键点击策略研究台，选择“创建快捷方式”。";
    }
    return "";
  }

  function manualGuide() {
    if (appleMobile) {
      const first = safari
        ? "在 Safari 工具栏轻点“分享”。部分布局需先轻点“更多”。"
        : "轻点浏览器的“分享”。也可以用 Safari 打开本页，再轻点“分享”。";
      const last = "如果出现“作为网页 App 打开”，请开启它，再轻点“添加”。";
      return ["添加到主屏幕", "在主屏幕上轻点图标即可打开策略研究台。", [
        first, "选择“添加到主屏幕”。在 Safari 中可通过“编辑操作”找到这一项。", last
      ]];
    }
    if (android) {
      return ["添加到主屏幕", "通过手机浏览器把策略研究台添加到主屏幕。", [
        "打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。新版 Chrome 中可选择“安装并创建快捷方式”。",
        "选择“安装”或“添加”，然后按系统提示确认。若菜单中没有安装选项，可在 Chrome 中打开本页。"
      ]];
    }
    if (safari && mac) {
      return ["添加到程序坞", "macOS Sonoma 14 及以上版本可在 Safari 中安装策略研究台。", [
        "在菜单栏打开“文件”，选择“添加到程序坞”。",
        "确认名称并点按“添加”。之后可从程序坞或“应用程序”打开。"
      ]];
    }
    if (edge) {
      return ["安装到电脑", "使用 Edge 的安装菜单添加策略研究台。", [
        "点击地址栏中的应用图标，或打开“…”菜单，在“更多工具”中找到“应用”。",
        "选择“将此站点作为应用安装”，确认安装。", desktopShortcut()
      ]];
    }
    if (chrome) {
      return ["安装到电脑", "使用 Chrome 的安装菜单添加策略研究台。", [
        "点击地址栏中的安装图标，或打开“⋮”菜单，选择“投放、保存和分享”。",
        "选择“将网页安装为应用”，然后确认安装。", desktopShortcut()
      ]];
    }
    if (windows && /Firefox\//.test(ua)) {
      return ["添加到任务栏", "Windows 版 Firefox 可将策略研究台保存为独立窗口。", [
        "在支持此功能的 Firefox 中，点击地址栏右侧的网页应用按钮。",
        "按提示将应用固定到任务栏。也可以在 Chrome 或 Edge 中打开本页，安装后创建桌面快捷方式。"
      ]];
    }
    return ["安装到电脑", "可使用 Chrome 或 Edge 安装策略研究台。", [
      "复制本页网址，在 Chrome 或 Edge 的普通窗口中打开。",
      "点击研究台右上角的“安装应用”，按提示完成安装。"
    ]];
  }

  function state() {
    if (appWindow.matches || navigator.standalone === true) return "standalone";
    if (installedHere) return "installed";
    return installPrompt ? "ready" : "manual";
  }

  function render() {
    const current = state();
    entry.dataset.installState = current;
    label.textContent = current === "standalone" ? "已在应用中" : current === "installed" ? "已安装" : "安装应用";
    let guide;
    if (current === "standalone") {
      guide = ["已在应用中", "策略研究台已在独立窗口中打开。", []];
    } else if (current === "installed") {
      guide = ["已安装策略研究台", "你可以从设备上的应用图标再次打开研究台。", [desktopShortcut()]];
    } else if (current === "ready" || waiting) {
      guide = ["安装策略研究台", appleMobile || android
        ? "安装后，可以直接从手机主屏幕打开行情和回测。"
        : "安装后，可以在独立窗口中查看行情和运行回测。", []];
    } else {
      guide = manualGuide();
    }
    title.textContent = guide[0];
    intro.textContent = guide[1];
    const items = guide[2].filter(Boolean).map(text => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    });
    steps.replaceChildren(...items);
    steps.hidden = !items.length;
    status.textContent = feedback;
    status.hidden = !feedback;
    confirm.hidden = current !== "ready" && !waiting;
    confirm.disabled = waiting;
    confirm.textContent = waiting ? "等待系统确认…" : "继续安装";
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    installedHere = false;
    feedback = "";
    render();
  });
  window.addEventListener("appinstalled", () => {
    installedHere = true;
    installPrompt = null;
    waiting = false;
    feedback = "";
    render();
  });
  appWindow.addEventListener("change", render);
  entry.addEventListener("click", () => {
    render();
    dialog.showModal();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => entry.focus({ preventScroll: true }));
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) dialog.close();
  });
  confirm.addEventListener("click", async () => {
    if (!installPrompt || waiting) return;
    const request = installPrompt;
    installPrompt = null;
    waiting = true;
    feedback = "";
    render();
    try {
      await request.prompt();
      const { outcome } = await request.userChoice;
      if (!installedHere) feedback = outcome === "accepted"
        ? "已提交安装请求，请留意设备上的确认提示。"
        : "此次安装已取消。你仍可通过浏览器菜单安装。";
    } catch {
      if (!installedHere) feedback = "系统安装窗口暂时无法打开，请使用浏览器菜单安装。";
    } finally {
      waiting = false;
      render();
      if (dialog.open) close.focus({ preventScroll: true });
    }
  });
  render();
  entry.hidden = false;
})();
