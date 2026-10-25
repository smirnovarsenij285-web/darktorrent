const api = window.darkTorrent;

const $ = id => document.getElementById(id);

const state = {
  downloads: [],
  view: "downloads",
  filter: "all",
  search: "",
  sort: "default",
  settings: null,
  settingsDirty: false,
  serviceError: "",
  refreshInFlight: false,
  timer: null,
  doneSeen: new Map(),
  firstSnapshot: true,
  lastTooltip: ""
};

const cards = new Map();

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function num(value) {
  return Number(value) || 0;
}

function formatBytes(value) {
  const n = num(value);

  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)} GB`;

  return `${(n / 1024 ** 4).toFixed(2)} TB`;
}

function formatSpeed(value) {
  return `${formatBytes(value)}/s`;
}

function formatETA(remaining, bytesPerSecond) {
  if (remaining <= 0) return "Почти готово";
  if (bytesPerSecond <= 0) return "Расчёт недоступен";

  const seconds = Math.ceil(remaining / bytesPerSecond);

  if (seconds < 60) return `~${seconds} сек`;

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    const rest = seconds % 60;
    return `~${minutes} мин` + (rest ? ` ${rest} сек` : "");
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    const rest = minutes % 60;
    return `~${hours} ч` + (rest ? ` ${rest} мин` : "");
  }

  const days = Math.floor(hours / 24);
  const rest = hours % 24;

  return `~${days} д` + (rest ? ` ${rest} ч` : "");
}

function cleanError(error) {
  const message = error?.message || String(error || "Неизвестная ошибка.");

  return message.replace(
    /^Error invoking remote method '[^']+':\s*(Error:\s*)?/,
    ""
  );
}

function safeStorage(action, key, value) {
  try {
    if (action === "get") return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {}

  return null;
}

function setText(element, value) {
  if (element && element.textContent !== value) {
    element.textContent = value;
  }
}

function progressOf(item) {
  const total = num(item.totalLength);

  if (!total) return 0;

  return Math.min(100, (num(item.completedLength) / total) * 100);
}

function isSeeding(item) {
  return item.status === "active" && item.seeder === "true";
}

function isDone(item) {
  if (item.status === "complete") return true;

  const total = num(item.totalLength);

  return total > 0 && num(item.completedLength) >= total;
}

function viewState(item) {
  if (isSeeding(item)) return "seeding";

  return ["active", "waiting", "paused", "complete", "error"].includes(item.status)
    ? item.status
    : "waiting";
}

const STATUS_LABELS = {
  active: "Скачивание",
  seeding: "Раздаётся",
  waiting: "В очереди",
  paused: "Пауза",
  complete: "Готово",
  error: "Ошибка"
};

const ICON_PATHS = {
  download: '<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/>',
  upload: '<path d="M12 20V9m0 0-4.5 4.5M12 9l4.5 4.5M5 5h14"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  retry: '<path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4.5h4.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  minus: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M10 11v6M14 11v6"/>',
  seed: '<path d="M12 19V6m0 0-5 5m5-5 5 5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="8.5"/>'
};

function icon(name, size) {
  const style = size ? ` style="width:${size}px;height:${size}px"` : "";

  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"${style}>${ICON_PATHS[name] || ""}</svg>`;
}

function toast(message, type = "info", duration = 3600) {
  const box = $("toasts");

  if (!box) return;

  const element = document.createElement("div");

  element.className = `toast ${type}`;
  element.textContent = message;

  box.appendChild(element);

  requestAnimationFrame(() => element.classList.add("show"));

  setTimeout(() => {
    element.classList.remove("show");
    setTimeout(() => element.remove(), 250);
  }, duration);
}

function confirmDialog(message, { okText = "Подтвердить", danger = false } = {}) {
  return new Promise(resolve => {
    const modal = $("confirmModal");
    const ok = $("confirmOk");
    const cancel = $("confirmCancel");

    $("confirmText").textContent = message;

    ok.textContent = okText;
    ok.classList.toggle("dangerSolid", danger);

    const finish = value => {
      modal.classList.add("hidden");

      ok.onclick = null;
      cancel.onclick = null;
      modal.onclick = null;

      resolve(value);
    };

    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);

    modal.onclick = event => {
      if (event.target === modal) finish(false);
    };

    modal.classList.remove("hidden");
    ok.focus();
  });
}

function showView(view) {
  state.view = view;

  document.querySelectorAll(".view").forEach(element => {
    element.classList.toggle("hidden", element.dataset.view !== view);
  });

  document.querySelectorAll(".navButton").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  if (view === "downloads") {
    startDownloadsView();
  }

  if (view === "settings" && !state.settingsDirty) {
    loadSettings();
  }
}

async function startDownloadsView() {
  try {
    await api.start();

    state.serviceError = "";

    await refreshDownloads();

    if (!state.timer) {
      state.timer = setInterval(async () => {
        try {
          await api.start();
          state.serviceError = "";
        } catch (error) {
          state.serviceError = cleanError(error);
        }

        await refreshDownloads();
      }, 1000);
    }
  } catch (error) {
    console.error(error);

    state.serviceError = cleanError(error);

    renderDownloads();
    updateSummary();
  }
}

async function refreshDownloads() {
  if (state.refreshInFlight) return;

  state.refreshInFlight = true;

  try {
    const next = await api.status();

    if (Array.isArray(next)) {
      state.downloads = next;
      detectCompletions(next);
    }
  } catch (error) {
    console.error("DarkTorrent refresh error:", error);
  } finally {
    renderDownloads();
    updateSummary();

    state.refreshInFlight = false;
  }
}

function detectCompletions(items) {
  for (const item of items) {
    if (item.isMetadata) continue;

    const done = isDone(item);
    const wasDone = state.doneSeen.get(item.gid);

    if (!state.firstSnapshot && wasDone === false && done) {
      notifyComplete(item);
    }

    state.doneSeen.set(item.gid, done);
  }

  state.firstSnapshot = false;
}

function notifyComplete(item) {
  toast(`Загрузка завершена: ${item.displayName}`, "success", 5000);

  if (state.settings?.general?.notifyOnComplete === false) return;

  if (!document.hasFocus()) {
    try {
      new Notification("Загрузка завершена", {
        body: item.displayName,
        silent: false
      });
    } catch {}
  }
}

function visibleDownloads() {
  return state.downloads.filter(item => !item.isMetadata);
}

function updateSummary() {
  const items = visibleDownloads();
  const active = items.filter(item => item.status === "active");

  const down = active.reduce((sum, item) => sum + num(item.downloadSpeed), 0);
  const up = active.reduce((sum, item) => sum + num(item.uploadSpeed), 0);

  setText($("statDown"), formatSpeed(down));
  setText($("statUp"), formatSpeed(up));
  setText($("statActive"), `${active.length} / ${items.length}`);

  const badge = $("navBadge");

  if (badge) {
    badge.textContent = active.length;
    badge.classList.toggle("hidden", !active.length);
  }

  $("connectionDot")?.classList.toggle("error", Boolean(state.serviceError));

  let status = "Готово";

  if (state.serviceError) {
    status = "Служба загрузок недоступна";
  } else if (active.length) {
    status = `↓ ${formatSpeed(down)}  ·  ↑ ${formatSpeed(up)}`;
  }

  setText($("connectionStatus"), status);

  const tooltip = active.length
    ? `DarkTorrent — ↓ ${formatSpeed(down)}  ↑ ${formatSpeed(up)}`
    : "DarkTorrent";

  if (tooltip !== state.lastTooltip) {
    state.lastTooltip = tooltip;
    api.setTrayTooltip(tooltip).catch(() => {});
  }
}

function matchesFilter(item, filter) {
  return filter === "all" || item.status === filter;
}

const SORTERS = {
  name: (a, b) => a.displayName.localeCompare(b.displayName, "ru"),
  progress: (a, b) => progressOf(b) - progressOf(a),
  size: (a, b) => num(b.totalLength) - num(a.totalLength),
  speed: (a, b) => num(b.downloadSpeed) - num(a.downloadSpeed)
};

function updateFilterCounts(items) {
  const counts = { all: items.length, active: 0, waiting: 0, paused: 0, complete: 0, error: 0 };

  for (const item of items) {
    if (item.status in counts) counts[item.status]++;
  }

  document.querySelectorAll("[data-count]").forEach(element => {
    setText(element, String(counts[element.dataset.count] ?? 0));
  });
}

function setFilter(filter) {
  state.filter = filter;
  safeStorage("set", "dt.filter", filter);

  document.querySelectorAll(".filterChip").forEach(chip => {
    chip.classList.toggle("active", chip.dataset.filter === filter);
  });

  renderDownloads();
}

function createCard(gid) {
  const card = document.createElement("div");

  card.className = "downloadCard";
  card.dataset.gid = gid;

  card.innerHTML = `
    <div class="cardTop">

      <div class="cardIcon" data-r="icon"></div>

      <div class="cardMain">
        <div class="downloadName" data-r="name"></div>

        <div class="cardMeta">
          <span class="chip" data-r="chip"></span>
          <span class="metaItem" data-r="size"></span>
          <span class="metaItem" data-r="eta"></span>
        </div>
      </div>

      <div class="percent" data-r="percent"></div>

      <div class="actions" data-r="actions"></div>

    </div>

    <div class="progressBar">
      <div class="progressFill" data-r="fill"></div>
    </div>

    <div class="cardStats">
      <span title="Скорость скачивания">↓<b data-r="dl"></b></span>
      <span title="Скорость отдачи">↑<b data-r="ul"></b></span>
      <span title="Сиды">Сиды<b data-r="seeds"></b></span>
      <span title="Соединения">Соединения<b data-r="conns"></b></span>
      <span title="Отдано / скачано">Рейтинг<b data-r="ratio"></b></span>
    </div>

    <div class="cardError hidden" data-r="error"></div>
  `;

  card._r = {};

  card.querySelectorAll("[data-r]").forEach(element => {
    card._r[element.dataset.r] = element;
  });

  return card;
}

function actionButton(action, gid, title, iconName, extraClass = "") {
  return `
    <button
      class="iconBtn ${extraClass}"
      data-download-action="${action}"
      data-gid="${escapeHtml(gid)}"
      title="${escapeHtml(title)}"
    >${icon(iconName)}</button>
  `;
}

function actionsMarkup(item, viewKey) {
  let html = "";

  if (viewKey === "active" || viewKey === "seeding") {
    html += actionButton("pause", item.gid, "Пауза", "pause");
  } else if (viewKey === "error") {
    html += actionButton("retry", item.gid, "Повторить", "retry");
  } else if (viewKey !== "complete") {
    html += actionButton("resume", item.gid, "Продолжить", "play");
  }

  html += actionButton("open", item.gid, "Показать в папке", "folder");
  html += actionButton("removeKeepFiles", item.gid, "Убрать из списка, оставить файлы", "minus");
  html += actionButton("remove", item.gid, "Отменить и удалить файлы", "trash", "dangerBtn");

  return html;
}

function updateCard(card, item) {
  const r = card._r;

  const total = num(item.totalLength);
  const completed = num(item.completedLength);
  const uploaded = num(item.uploadLength);

  const key = viewState(item);
  const percent = key === "seeding" || key === "complete" ? 100 : progressOf(item);

  card.dataset.state = key;

  setText(r.name, item.displayName);
  r.name.title = item.displayName;

  r.chip.className = `chip ${key}`;
  setText(r.chip, STATUS_LABELS[key]);

  const iconName = { complete: "check", seeding: "seed", error: "alert" }[key] || "download";

  if (card.dataset.icon !== iconName) {
    card.dataset.icon = iconName;
    r.icon.innerHTML = icon(iconName);
  }

  let sizeText = "";
  let etaText = "";

  if (!total && key === "active") {
    etaText = "Получение метаданных…";
  } else if (total) {
    sizeText = key === "complete" || key === "seeding"
      ? formatBytes(total)
      : `${formatBytes(completed)} из ${formatBytes(total)}`;

    if (key === "active") {
      etaText = formatETA(total - completed, num(item.downloadSpeed));
    }
  }

  setText(r.size, sizeText);
  setText(r.eta, etaText);

  setText(r.percent, percent >= 100 ? "100%" : `${percent.toFixed(1)}%`);

  r.fill.style.width = `${percent}%`;

  setText(r.dl, ` ${formatSpeed(item.downloadSpeed)}`);
  setText(r.ul, ` ${formatSpeed(item.uploadSpeed)}`);
  setText(r.seeds, ` ${num(item.numSeeders)}`);
  setText(r.conns, ` ${num(item.connections)}`);
  setText(r.ratio, ` ${completed ? (uploaded / completed).toFixed(2) : "0.00"}`);

  const errorText = item.status === "error" ? (item.errorMessage || "Неизвестная ошибка") : "";

  setText(r.error, errorText);
  r.error.classList.toggle("hidden", !errorText);

  const actionsKey = key === "seeding" ? "active" : key;

  if (card.dataset.actions !== actionsKey) {
    card.dataset.actions = actionsKey;
    r.actions.innerHTML = actionsMarkup(item, key);
  }
}

function renderDownloads() {
  const container = $("downloadCards");

  if (!container) return;

  const base = visibleDownloads();

  setText($("downloadCount"), String(base.length));

  updateFilterCounts(base);

  const query = state.search.trim().toLowerCase();

  let items = base.filter(item =>
    matchesFilter(item, state.filter) &&
    (!query || item.displayName.toLowerCase().includes(query))
  );

  if (SORTERS[state.sort]) {
    items = [...items].sort(SORTERS[state.sort]);
  }

  const wanted = new Set(items.map(item => item.gid));

  for (const [gid, element] of cards) {
    if (!wanted.has(gid)) {
      element.remove();
      cards.delete(gid);
    }
  }

  items.forEach((item, index) => {
    let card = cards.get(item.gid);

    if (!card) {
      card = createCard(item.gid);
      cards.set(item.gid, card);
    }

    updateCard(card, item);

    if (container.children[index] !== card) {
      container.insertBefore(card, container.children[index] || null);
    }
  });

  renderEmptyState(base.length, items.length);
}

function renderEmptyState(totalCount, shownCount) {
  const empty = $("downloadEmpty");

  if (!empty) return;

  empty.classList.toggle("hidden", shownCount > 0);

  if (shownCount > 0) return;

  const actions = $("emptyActions");

  if (state.serviceError && !totalCount) {
    setText($("emptyTitle"), "Не удалось запустить службу загрузок");
    setText($("emptyText"), state.serviceError);
    actions.classList.add("hidden");
  } else if (!totalCount) {
    setText($("emptyTitle"), "Пока нет загрузок");
    setText(
      $("emptyText"),
      "Перетащите .torrent-файл в окно, вставьте magnet-ссылку через Ctrl + V или нажмите «Добавить»."
    );
    actions.classList.remove("hidden");
  } else {
    setText($("emptyTitle"), "Ничего не найдено");
    setText($("emptyText"), "Измените строку поиска или фильтр.");
    actions.classList.add("hidden");
  }
}

$("downloadCards")?.addEventListener("click", async event => {
  const button = event.target.closest("[data-download-action]");

  if (!button) return;

  const action = button.dataset.downloadAction;
  const gid = button.dataset.gid;

  try {
    if (action === "pause") await api.pause(gid);
    if (action === "resume") await api.resume(gid);
    if (action === "retry") await api.retry(gid);
    if (action === "open") await api.openDownload(gid);

    if (action === "removeKeepFiles" || action === "remove") {
      const deleting = action === "remove";

      if (state.settings?.general?.confirmRemove !== false) {
        const accepted = await confirmDialog(
          deleting
            ? "Отменить загрузку и удалить скачанные файлы?"
            : "Убрать задачу из DarkTorrent, но оставить скачанные файлы?",
          {
            okText: deleting ? "Удалить" : "Убрать",
            danger: deleting
          }
        );

        if (!accepted) return;
      }

      button.disabled = true;

      if (deleting) {
        await api.remove(gid);
      } else {
        await api.removeKeepFiles(gid);
      }
    }

    await refreshDownloads();
  } catch (error) {
    toast(cleanError(error), "error", 5000);
    await refreshDownloads();
  }
});

$("pauseAll")?.addEventListener("click", async () => {
  try {
    await api.pauseAll();
    await refreshDownloads();
  } catch (error) {
    toast(cleanError(error), "error");
  }
});

$("resumeAll")?.addEventListener("click", async () => {
  try {
    await api.resumeAll();
    await refreshDownloads();
  } catch (error) {
    toast(cleanError(error), "error");
  }
});

$("clearCompleted")?.addEventListener("click", async () => {
  try {
    const removed = await api.clearCompleted();

    toast(
      removed ? `Убрано завершённых: ${removed}` : "Завершённых загрузок нет",
      removed ? "success" : "info"
    );

    await refreshDownloads();
  } catch (error) {
    toast(cleanError(error), "error");
  }
});

$("searchInput")?.addEventListener("input", event => {
  state.search = event.target.value;
  renderDownloads();
});

$("filterBar")?.addEventListener("click", event => {
  const chip = event.target.closest("[data-filter]");

  if (chip) setFilter(chip.dataset.filter);
});

$("sortSelect")?.addEventListener("change", event => {
  state.sort = event.target.value;
  safeStorage("set", "dt.sort", state.sort);
  renderDownloads();
});

function extractMagnets(text) {
  const found = String(text || "").match(/magnet:\?[^\s"'<>]+/gi) || [];

  return [...new Set(found)];
}

function fileToBase64(file) {
  return file.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;

    let binary = "";

    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }

    return btoa(binary);
  });
}

async function addMagnets(list) {
  let added = 0;

  for (const magnet of list) {
    try {
      await api.addMagnet(magnet);
      added++;
    } catch (error) {
      toast(cleanError(error), "error", 5000);
    }
  }

  if (added) {
    toast(
      added === 1 ? "Magnet-ссылка добавлена" : `Добавлено magnet-ссылок: ${added}`,
      "success"
    );
  }

  await refreshDownloads();

  return added;
}

async function addTorrentFiles(files) {
  let added = 0;

  for (const file of files) {
    if (!/\.torrent$/i.test(file.name)) continue;

    if (file.size > 10 * 1024 * 1024) {
      toast(`Файл «${file.name}» слишком большой для .torrent`, "error");
      continue;
    }

    try {
      await api.addTorrentData(await fileToBase64(file));
      added++;
    } catch (error) {
      toast(`${file.name}: ${cleanError(error)}`, "error", 5000);
    }
  }

  if (added) {
    toast(
      added === 1 ? "Торрент добавлен" : `Добавлено торрентов: ${added}`,
      "success"
    );
  }

  await refreshDownloads();

  return added;
}

function openAddModal() {
  $("addModal")?.classList.remove("hidden");
  $("magnetInput")?.focus();
}

function closeAddModal() {
  $("addModal")?.classList.add("hidden");
}

$("addButton")?.addEventListener("click", openAddModal);
$("emptyAddMagnet")?.addEventListener("click", openAddModal);
$("closeAdd")?.addEventListener("click", closeAddModal);

$("addModal")?.addEventListener("click", event => {
  if (event.target === $("addModal")) closeAddModal();
});

$("addMagnet")?.addEventListener("click", async () => {
  const magnets = extractMagnets($("magnetInput")?.value);

  if (!magnets.length) {
    toast("Вставьте корректную magnet-ссылку.", "error");
    return;
  }

  closeAddModal();

  $("magnetInput").value = "";

  await addMagnets(magnets);
});

async function chooseTorrentFiles() {
  try {
    const added = await api.addTorrent();

    if (added) {
      closeAddModal();
      toast(added === 1 ? "Торрент добавлен" : `Добавлено торрентов: ${added}`, "success");
    }

    await refreshDownloads();
  } catch (error) {
    toast(cleanError(error), "error", 5000);
  }
}

$("chooseTorrent")?.addEventListener("click", chooseTorrentFiles);
$("emptyChooseTorrent")?.addEventListener("click", chooseTorrentFiles);

$("magnetInput")?.addEventListener("keydown", event => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    $("addMagnet")?.click();
  }
});

api.onAdded(payload => {
  if (payload?.ok) {
    toast(
      payload.kind === "magnet" ? "Magnet-ссылка добавлена" : "Торрент добавлен",
      "success"
    );

    refreshDownloads();
  } else {
    toast(payload?.error || "Не удалось добавить загрузку.", "error", 5000);
  }
});

let dragDepth = 0;

function hasDroppable(event) {
  const types = Array.from(event.dataTransfer?.types || []);

  return types.includes("Files") || types.includes("text/plain") || types.includes("text/uri-list");
}

function setDropOverlay(visible) {
  $("dropOverlay")?.classList.toggle("hidden", !visible);
}

window.addEventListener("dragenter", event => {
  if (!hasDroppable(event)) return;

  dragDepth++;
  setDropOverlay(true);
});

window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);

  if (!dragDepth) setDropOverlay(false);
});

window.addEventListener("dragover", event => {
  if (hasDroppable(event)) event.preventDefault();
});

window.addEventListener("drop", async event => {

  event.preventDefault();

  dragDepth = 0;
  setDropOverlay(false);

  const files = Array.from(event.dataTransfer?.files || []);
  const text = event.dataTransfer?.getData("text/plain") || "";

  const torrents = files.filter(file => /\.torrent$/i.test(file.name));
  const magnets = extractMagnets(text);

  if (!torrents.length && !magnets.length) {
    toast("Перетащите .torrent-файл или magnet-ссылку.", "info");
    return;
  }

  if (state.view !== "downloads") showView("downloads");

  if (torrents.length) await addTorrentFiles(torrents);
  if (magnets.length) await addMagnets(magnets);
});

document.addEventListener("paste", event => {
  const target = event.target;

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (state.view !== "downloads") return;

  const magnets = extractMagnets(event.clipboardData?.getData("text/plain"));

  if (magnets.length) {
    event.preventDefault();
    addMagnets(magnets);
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (!$("confirmModal").classList.contains("hidden")) {
      $("confirmCancel").click();
    } else if (!$("addModal").classList.contains("hidden")) {
      closeAddModal();
    }

    return;
  }

  if (!(event.ctrlKey || event.metaKey)) return;

  const key = event.key.toLowerCase();

  if (key === "f" && state.view === "downloads") {
    event.preventDefault();
    $("searchInput")?.focus();
    $("searchInput")?.select();
  }

  if (key === "n") {
    event.preventDefault();

    if (state.view !== "downloads") showView("downloads");

    openAddModal();
  }
});

function setSettingsStatus(text, warn = false) {
  const element = $("settingsStatus");

  if (!element) return;

  element.textContent = text;
  element.classList.toggle("warn", warn);
}

function markSettingsDirty() {
  if (state.settingsDirty) return;

  state.settingsDirty = true;
  setSettingsStatus("Есть несохранённые изменения", true);
}

function syncProxyFields() {
  const enabled = Boolean($("proxyType")?.value);

  ["proxyHost", "proxyPort", "proxyUsername", "proxyPassword"].forEach(id => {
    const element = $(id);

    if (element) element.disabled = !enabled;
  });
}

function applyCompactMode(enabled) {
  document.body.classList.toggle("compactMode", Boolean(enabled));
}

async function loadSettings() {
  try {
    const settings = await api.getSettings();

    state.settings = settings;

    $("downloadDir").value = settings.downloadDir;

    $("startWithWindows").checked = Boolean(settings.general.startWithWindows);
    $("startMinimized").checked = Boolean(settings.general.startMinimized);
    $("closeToTray").checked = Boolean(settings.general.closeToTray);
    $("confirmRemove").checked = Boolean(settings.general.confirmRemove);
    $("compactMode").checked = Boolean(settings.general.compactMode);
    $("notifyOnComplete").checked = Boolean(settings.general.notifyOnComplete);
    $("handleMagnet").checked = Boolean(settings.general.handleMagnet);

    $("maxConcurrent").value = settings.downloads.maxConcurrent;
    $("maxConnections").value = settings.downloads.maxConnections;
    $("split").value = settings.downloads.split;
    $("minSplitSize").value = settings.downloads.minSplitSize;
    $("maxDownloadSpeed").value = settings.downloads.maxDownloadSpeed;
    $("maxUploadSpeed").value = settings.downloads.maxUploadSpeed;
    $("fileAllocation").value = settings.downloads.fileAllocation;
    $("continueDownloads").checked = Boolean(settings.downloads.continueDownloads);
    $("autoFileRenaming").checked = Boolean(settings.downloads.autoFileRenaming);

    $("dht").checked = Boolean(settings.bittorrent.dht);
    $("peerExchange").checked = Boolean(settings.bittorrent.peerExchange);
    $("lpd").checked = Boolean(settings.bittorrent.lpd);
    $("seedTime").value = settings.bittorrent.seedTime;
    $("seedRatio").value = settings.bittorrent.seedRatio;
    $("saveMetadata").checked = Boolean(settings.bittorrent.saveMetadata);
    $("listenPort").value = settings.bittorrent.listenPort || "";

    $("proxyType").value = settings.proxy.type || "";
    $("proxyHost").value = settings.proxy.host || "";
    $("proxyPort").value = settings.proxy.port || "";
    $("proxyUsername").value = settings.proxy.username || "";
    $("proxyPassword").value = settings.proxy.password || "";

    syncProxyFields();
    applyCompactMode(settings.general.compactMode);

    state.settingsDirty = false;
    setSettingsStatus("");
  } catch (error) {
    console.error(error);
    toast(`Не удалось загрузить настройки: ${cleanError(error)}`, "error");
  }
}

function collectSettings() {
  return {
    downloadDir: $("downloadDir").value,

    general: {
      startWithWindows: $("startWithWindows").checked,
      startMinimized: $("startMinimized").checked,
      closeToTray: $("closeToTray").checked,
      confirmRemove: $("confirmRemove").checked,
      compactMode: $("compactMode").checked,
      notifyOnComplete: $("notifyOnComplete").checked,
      handleMagnet: $("handleMagnet").checked
    },

    downloads: {
      maxConcurrent: Math.max(1, num($("maxConcurrent").value) || 3),
      maxConnections: Math.max(1, num($("maxConnections").value) || 4),
      split: Math.max(1, num($("split").value) || 4),
      minSplitSize: $("minSplitSize").value.trim() || "1M",
      maxDownloadSpeed: $("maxDownloadSpeed").value.trim() || "0",
      maxUploadSpeed: $("maxUploadSpeed").value.trim() || "0",
      fileAllocation: $("fileAllocation").value,
      continueDownloads: $("continueDownloads").checked,
      autoFileRenaming: $("autoFileRenaming").checked
    },

    bittorrent: {
      dht: $("dht").checked,
      peerExchange: $("peerExchange").checked,
      lpd: $("lpd").checked,
      seedTime: Math.max(0, num($("seedTime").value)),
      seedRatio: Math.max(0, num($("seedRatio").value)),
      saveMetadata: $("saveMetadata").checked,
      listenPort: $("listenPort").value.trim()
    },

    proxy: {
      type: $("proxyType").value,
      host: $("proxyHost").value.trim(),
      port: $("proxyPort").value.trim(),
      username: $("proxyUsername").value.trim(),
      password: $("proxyPassword").value
    }
  };
}

$("saveSettings")?.addEventListener("click", async () => {
  try {
    const next = collectSettings();

    if (next.proxy.type && (!next.proxy.host || !next.proxy.port)) {
      toast("Для прокси укажите хост и порт.", "error");
      return;
    }

    const previousPort = state.settings?.bittorrent?.listenPort || "";

    state.settings = await api.saveSettings(next);

    applyCompactMode(next.general.compactMode);

    state.settingsDirty = false;
    setSettingsStatus("Настройки сохранены");

    setTimeout(() => {
      if (!state.settingsDirty) setSettingsStatus("");
    }, 2500);

    if (next.bittorrent.listenPort !== previousPort) {
      toast("Новый порт применится после перезапуска DarkTorrent.", "info", 5000);
    }
  } catch (error) {
    toast(cleanError(error), "error", 5000);
  }
});

$("resetSettings")?.addEventListener("click", async () => {
  const accepted = await confirmDialog("Сбросить все настройки к значениям по умолчанию?", {
    okText: "Сбросить",
    danger: true
  });

  if (!accepted) return;

  try {
    await api.resetSettings();

    state.settingsDirty = false;

    await loadSettings();

    setSettingsStatus("Настройки сброшены");
  } catch (error) {
    toast(cleanError(error), "error");
  }
});

$("exportSettings")?.addEventListener("click", async () => {
  try {
    if (await api.exportSettings()) {
      toast("Настройки экспортированы", "success");
    }
  } catch (error) {
    toast(cleanError(error), "error");
  }
});

$("importSettings")?.addEventListener("click", async () => {
  try {
    if (await api.importSettings()) {
      state.settingsDirty = false;

      await loadSettings();

      toast("Настройки импортированы", "success");
    }
  } catch (error) {
    toast(cleanError(error), "error");
  }
});

$("chooseDir")?.addEventListener("click", async () => {
  try {
    const dir = await api.chooseDir();

    if (dir) {
      $("downloadDir").value = dir;

      if (state.settings) state.settings.downloadDir = dir;
    }
  } catch (error) {
    toast(cleanError(error), "error");
  }
});

$("folderButton")?.addEventListener("click", () => {
  api.openDir();
});

$("compactMode")?.addEventListener("change", event => {
  applyCompactMode(event.target.checked);
});

$("proxyType")?.addEventListener("change", syncProxyFields);

document
  .querySelector('.view[data-view="settings"]')
  ?.addEventListener("input", markSettingsDirty);

document
  .querySelector('.view[data-view="settings"]')
  ?.addEventListener("change", markSettingsDirty);

document.querySelectorAll(".settingsNavButton").forEach(button => {
  button.addEventListener("click", () => {
    const section = button.dataset.section;

    document.querySelectorAll(".settingsNavButton").forEach(item => {
      item.classList.toggle("active", item === button);
    });

    document.querySelectorAll(".settingsSection").forEach(item => {
      item.classList.toggle("hidden", item.dataset.section !== section);
    });
  });
});

document.querySelectorAll(".navButton").forEach(button => {
  button.addEventListener("click", () => {
    showView(button.dataset.view);
  });
});

async function startup() {
  if (/Mac/i.test(navigator.platform)) {
    document.body.classList.add("mac");
  }

  const savedSort = safeStorage("get", "dt.sort");
  const savedFilter = safeStorage("get", "dt.filter");

  if (savedSort && SORTERS[savedSort]) {
    state.sort = savedSort;
    $("sortSelect").value = savedSort;
  }

  if (savedFilter && document.querySelector(`[data-filter="${savedFilter}"]`)) {
    setFilter(savedFilter);
  }

  try {
    state.settings = await api.getSettings();

    applyCompactMode(state.settings.general.compactMode);
  } catch (error) {
    console.error(error);
  }

  showView("downloads");
}

startup();
