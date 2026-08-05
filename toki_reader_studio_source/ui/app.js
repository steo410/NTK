const state = {
  episodes: [],
  scanResult: null,
  downloading: false,
  library: [],
  readerSeriesSlug: "",
  readerEpisodeNumber: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const titles = {
  collect: [
    "자료 수집",
    "작품 링크를 넣고 회차를 선택해 한 번에 저장합니다.",
  ],
  library: [
    "내 보관함",
    "완료된 작품과 회차를 확인합니다.",
  ],
  reader: [
    "세로 스크롤 리더",
    "저장된 이미지를 실제 웹툰처럼 이어서 읽습니다.",
  ],
  export: [
    "배포용 리더",
    "정적 웹 리더 폴더를 생성합니다.",
  ],
  settings: [
    "설정",
    "저장 위치와 작업 브라우저를 관리합니다.",
  ],
};

function showToast(message, type = "") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $("#toast-container").appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4200);
}

function setGlobalStatus(text, type = "ready") {
  const pill = $("#global-status");
  pill.textContent = text;

  const styles = {
    ready: ["rgba(84,227,158,.22)", "rgba(84,227,158,.08)", "#54e39e"],
    busy: ["rgba(54,210,255,.22)", "rgba(54,210,255,.08)", "#76ddff"],
    error: ["rgba(255,95,115,.25)", "rgba(255,95,115,.08)", "#ff8292"],
  };

  const selected = styles[type] || styles.ready;
  pill.style.borderColor = selected[0];
  pill.style.background = selected[1];
  pill.style.color = selected[2];
}

function addLog(message) {
  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString("ko-KR", {
    hour12: false,
  });

  line.textContent = `[${time}] ${message}`;
  $("#log-box").appendChild(line);
  $("#log-box").scrollTop = $("#log-box").scrollHeight;
}

function switchTab(tabName) {
  $$(".nav-item").forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.tab === tabName,
    );
  });

  $$(".tab-panel").forEach((panel) => {
    panel.classList.toggle(
      "active",
      panel.id === `tab-${tabName}`,
    );
  });

  $("#page-title").textContent = titles[tabName][0];
  $("#page-subtitle").textContent = titles[tabName][1];

  if (tabName === "library" || tabName === "reader" || tabName === "export") {
    refreshLibrary();
  }
}

function renderEpisodeTable() {
  const body = $("#episode-table-body");
  body.innerHTML = "";

  if (state.episodes.length === 0) {
    body.innerHTML = `
      <tr class="empty-row">
        <td colspan="4">불러온 회차가 없습니다.</td>
      </tr>
    `;
    $("#episode-summary").textContent =
      "아직 불러온 회차가 없습니다.";
    $("#download-button").disabled = true;
    return;
  }

  for (const episode of state.episodes) {
    const row = document.createElement("tr");

    row.innerHTML = `
      <td>
        <input
          type="checkbox"
          class="episode-check"
          data-number="${episode.number}"
          ${episode.selected !== false ? "checked" : ""}
        >
      </td>
      <td><strong>${episode.number}화</strong></td>
      <td>${escapeHtml(episode.title || `${episode.number}화`)}</td>
      <td class="url-cell" title="${escapeHtml(episode.url)}">
        ${escapeHtml(episode.url)}
      </td>
    `;

    body.appendChild(row);
  }

  updateEpisodeSummary();
}

function updateEpisodeSummary() {
  const selectedCount = state.episodes.filter(
    (episode) => episode.selected !== false,
  ).length;

  $("#episode-summary").textContent =
    `총 ${state.episodes.length}개 중 ${selectedCount}개 선택`;

  $("#download-button").disabled =
    selectedCount === 0 || state.downloading;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function scanEpisodes() {
  const sourceUrl = $("#source-url").value.trim();
  const pastedUrls = $("#pasted-urls").value.trim();
  const minEpisode = Number($("#min-episode").value);
  const maxEpisode = Number($("#max-episode").value);
  const showBrowser = $("#show-browser").checked;

  $("#scan-button").disabled = true;
  setGlobalStatus("목록 검색 중", "busy");
  addLog("회차 목록 검색을 시작했습니다.");

  try {
    const result = await window.tokiAPI.scanSource({
      sourceUrl,
      pastedUrls,
      minEpisode,
      maxEpisode,
      showBrowser,
    });

    state.scanResult = result;
    state.episodes = result.episodes;

    if (!$("#series-title").value.trim() && result.title) {
      $("#series-title").value = result.title;
    }

    renderEpisodeTable();
    addLog(`${result.count}개 회차를 찾았습니다.`);
    showToast(`${result.count}개 회차를 불러왔습니다.`, "success");
    setGlobalStatus("목록 준비됨", "ready");
  } catch (error) {
    addLog(`목록 검색 실패: ${error.message}`);
    showToast(error.message, "error");
    setGlobalStatus("목록 검색 실패", "error");
  } finally {
    $("#scan-button").disabled = false;
  }
}

function setDownloading(value) {
  state.downloading = value;

  $("#scan-button").disabled = value;
  $("#cancel-button").disabled = !value;
  $("#download-button").disabled =
    value ||
    state.episodes.filter(
      (episode) => episode.selected !== false,
    ).length === 0;
}

async function startDownload() {
  const title =
    $("#series-title").value.trim() ||
    state.scanResult?.title ||
    "웹툰";

  const sourceUrl =
    $("#source-url").value.trim() ||
    state.scanResult?.sourceUrl ||
    "";

  setDownloading(true);
  setGlobalStatus("다운로드 중", "busy");
  $("#progress-bar").style.width = "0%";
  $("#progress-percent").textContent = "0%";
  addLog("이미지 다운로드를 시작했습니다.");

  try {
    const result = await window.tokiAPI.startDownload({
      title,
      sourceUrl,
      episodes: state.episodes,
      showBrowser: $("#show-browser").checked,
      force: $("#force-download").checked,
    });

    if (result.cancelled) {
      showToast("다운로드가 중지되었습니다.");
      setGlobalStatus("중지됨", "error");
    } else {
      showToast(
        `${result.completedEpisodes}/${result.totalEpisodes}개 회차 완료`,
        "success",
      );
      setGlobalStatus("다운로드 완료", "ready");
      switchTab("library");
    }
  } catch (error) {
    addLog(`다운로드 오류: ${error.message}`);
    showToast(error.message, "error");
    setGlobalStatus("다운로드 실패", "error");
  } finally {
    setDownloading(false);
  }
}

function handleProgress(event) {
  switch (event.type) {
    case "status":
      addLog(event.message);
      break;

    case "scan-progress":
      $("#episode-summary").textContent =
        `검색 중 · 현재 ${event.found}개 발견`;
      break;

    case "warning":
      addLog(event.message);
      break;

    case "episode-start":
      $("#progress-episode").textContent =
        `${event.episode}화 · 회차 ${event.index}/${event.total}`;
      $("#progress-page").textContent = "본문 확인 중";
      addLog(`${event.episode}화 다운로드 시작`);
      break;

    case "page-progress": {
      const episodeRatio =
        (event.episodeIndex - 1) / event.episodeTotal;
      const pageRatio =
        (event.page / event.pageTotal) / event.episodeTotal;
      const percent = Math.min(
        100,
        Math.round((episodeRatio + pageRatio) * 100),
      );

      $("#progress-bar").style.width = `${percent}%`;
      $("#progress-percent").textContent = `${percent}%`;
      $("#progress-page").textContent =
        `페이지 ${event.page} / ${event.pageTotal}`;
      break;
    }

    case "episode-complete":
      addLog(
        `${event.episode}화 완료 · 이미지 ${event.pageCount}개`,
      );
      break;

    case "episode-skipped":
      addLog(`${event.episode}화는 이미 완료되어 건너뜁니다.`);
      break;

    case "episode-error":
      addLog(`${event.episode}화 오류 · ${event.message}`);
      break;

    case "all-complete":
      $("#progress-bar").style.width = "100%";
      $("#progress-percent").textContent = "100%";
      addLog(
        `전체 완료 · ${event.completedEpisodes}/${event.totalEpisodes}개 회차`,
      );
      break;

    case "cancelled":
      addLog("사용자가 다운로드를 중지했습니다.");
      break;
  }
}

async function refreshLibrary() {
  try {
    const result = await window.tokiAPI.listLibrary();
    state.library = result.series;

    $("#library-path").textContent = result.libraryRoot;
    renderLibrary();
    populateSeriesSelects();
  } catch (error) {
    showToast(`보관함 오류: ${error.message}`, "error");
  }
}

function renderLibrary() {
  const grid = $("#library-grid");
  grid.innerHTML = "";

  if (state.library.length === 0) {
    grid.innerHTML = `
      <article class="card">
        <h3>보관함이 비어 있습니다.</h3>
        <p>수집 탭에서 작품을 먼저 다운로드하세요.</p>
      </article>
    `;
    return;
  }

  for (const series of state.library) {
    const card = document.createElement("article");
    card.className = "library-card";

    card.innerHTML = `
      <div class="library-cover">
        ${
          series.coverUrl
            ? `<img src="${series.coverUrl}" alt="">`
            : ""
        }
      </div>
      <div class="library-body">
        <h3 title="${escapeHtml(series.title)}">
          ${escapeHtml(series.title)}
        </h3>
        <div class="library-meta">
          완료 회차 ${series.completedCount}개
        </div>
        <div class="library-buttons">
          <button
            class="button primary read-series"
            data-slug="${series.slug}"
          >
            읽기
          </button>
          <button
            class="button ghost open-series-folder"
            data-slug="${series.slug}"
          >
            폴더
          </button>
        </div>
      </div>
    `;

    grid.appendChild(card);
  }
}

function populateSeriesSelects() {
  const readerSeries = $("#reader-series");
  const exportSeries = $("#export-series");
  const currentReader = readerSeries.value;
  const currentExport = exportSeries.value;

  const options = state.library
    .map(
      (series) => `
        <option value="${series.slug}">
          ${escapeHtml(series.title)}
        </option>
      `,
    )
    .join("");

  readerSeries.innerHTML =
    `<option value="">작품 선택</option>${options}`;
  exportSeries.innerHTML =
    `<option value="">작품 선택</option>${options}`;

  if (state.library.some((series) => series.slug === currentReader)) {
    readerSeries.value = currentReader;
  }

  if (state.library.some((series) => series.slug === currentExport)) {
    exportSeries.value = currentExport;
  }
}

function populateReaderEpisodes(seriesSlug, preferredNumber = null) {
  const series = state.library.find(
    (item) => item.slug === seriesSlug,
  );

  const select = $("#reader-episode");
  select.innerHTML = `<option value="">회차 선택</option>`;

  if (!series) return;

  for (const episode of series.episodes) {
    const option = document.createElement("option");
    option.value = episode.number;
    option.textContent =
      `${episode.number}화 · ${episode.pageCount || 0}장`;
    select.appendChild(option);
  }

  if (
    preferredNumber !== null &&
    series.episodes.some(
      (episode) => Number(episode.number) === Number(preferredNumber),
    )
  ) {
    select.value = String(preferredNumber);
  }
}

async function openReader(seriesSlug, episodeNumber = null) {
  await refreshLibrary();

  const series = state.library.find(
    (item) => item.slug === seriesSlug,
  );

  if (!series) return;

  switchTab("reader");
  $("#reader-series").value = seriesSlug;

  const targetEpisode =
    episodeNumber ??
    series.episodes[0]?.number ??
    null;

  populateReaderEpisodes(seriesSlug, targetEpisode);

  if (targetEpisode !== null) {
    $("#reader-episode").value = String(targetEpisode);
    await loadReaderEpisode(seriesSlug, targetEpisode);
  }
}

async function loadReaderEpisode(seriesSlug, episodeNumber) {
  if (!seriesSlug || !episodeNumber) return;

  setGlobalStatus("이미지 불러오는 중", "busy");

  try {
    const images = await window.tokiAPI.getEpisodeImages(
      seriesSlug,
      Number(episodeNumber),
    );

    const canvas = $("#reader-canvas");
    canvas.innerHTML = "";

    for (const image of images) {
      const element = document.createElement("img");
      element.src = image.url;
      element.alt = `${episodeNumber}화 ${image.index}페이지`;
      element.loading = "lazy";
      canvas.appendChild(element);
    }

    state.readerSeriesSlug = seriesSlug;
    state.readerEpisodeNumber = Number(episodeNumber);

    $("#reader-empty").style.display =
      images.length > 0 ? "none" : "grid";
    canvas.classList.toggle("active", images.length > 0);

    window.scrollTo({ top: 0, behavior: "instant" });
    setGlobalStatus(
      `${episodeNumber}화 · ${images.length}장`,
      "ready",
    );
  } catch (error) {
    showToast(`리더 오류: ${error.message}`, "error");
    setGlobalStatus("리더 오류", "error");
  }
}

async function moveReaderEpisode(direction) {
  const series = state.library.find(
    (item) => item.slug === state.readerSeriesSlug,
  );

  if (!series) return;

  const index = series.episodes.findIndex(
    (episode) =>
      Number(episode.number) ===
      Number(state.readerEpisodeNumber),
  );

  const nextIndex = index + direction;

  if (nextIndex < 0 || nextIndex >= series.episodes.length) {
    showToast(
      direction < 0
        ? "첫 번째 회차입니다."
        : "마지막 회차입니다.",
    );
    return;
  }

  const nextEpisode = series.episodes[nextIndex];
  $("#reader-episode").value = String(nextEpisode.number);

  await loadReaderEpisode(
    state.readerSeriesSlug,
    nextEpisode.number,
  );
}

async function exportReader() {
  const seriesSlug = $("#export-series").value;

  if (!seriesSlug) {
    showToast("내보낼 작품을 선택하세요.", "error");
    return;
  }

  $("#export-button").disabled = true;
  setGlobalStatus("리더 내보내는 중", "busy");

  try {
    const result = await window.tokiAPI.exportStaticReader(
      seriesSlug,
    );

    if (result.cancelled) {
      $("#export-result").textContent =
        "내보내기를 취소했습니다.";
    } else {
      $("#export-result").innerHTML = `
        <strong>${result.episodeCount}개 회차 내보내기 완료</strong>
        <br>${escapeHtml(result.destination)}
      `;
      showToast("배포용 리더 폴더를 만들었습니다.", "success");
    }

    setGlobalStatus("준비됨", "ready");
  } catch (error) {
    $("#export-result").textContent = error.message;
    showToast(error.message, "error");
    setGlobalStatus("내보내기 실패", "error");
  } finally {
    $("#export-button").disabled = false;
  }
}

async function initialize() {
  window.tokiAPI.onProgress(handleProgress);

  const settings = await window.tokiAPI.getSettings();
  $("#library-path").textContent = settings.libraryRoot;

  await refreshLibrary();

  $$(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      switchTab(button.dataset.tab);
    });
  });

  $("#scan-button").addEventListener("click", scanEpisodes);
  $("#download-button").addEventListener(
    "click",
    startDownload,
  );

  $("#cancel-button").addEventListener("click", async () => {
    await window.tokiAPI.cancelDownload();
    addLog("중지 요청을 보냈습니다.");
  });

  $("#episode-table-body").addEventListener(
    "change",
    (event) => {
      const checkbox = event.target.closest(".episode-check");
      if (!checkbox) return;

      const number = Number(checkbox.dataset.number);
      const episode = state.episodes.find(
        (item) => Number(item.number) === number,
      );

      if (episode) episode.selected = checkbox.checked;
      updateEpisodeSummary();
    },
  );

  $("#select-all").addEventListener("click", () => {
    state.episodes.forEach((episode) => {
      episode.selected = true;
    });
    renderEpisodeTable();
  });

  $("#select-none").addEventListener("click", () => {
    state.episodes.forEach((episode) => {
      episode.selected = false;
    });
    renderEpisodeTable();
  });

  $("#refresh-library").addEventListener(
    "click",
    refreshLibrary,
  );

  $("#library-grid").addEventListener("click", async (event) => {
    const readButton = event.target.closest(".read-series");
    const folderButton = event.target.closest(
      ".open-series-folder",
    );

    if (readButton) {
      await openReader(readButton.dataset.slug);
    }

    if (folderButton) {
      await window.tokiAPI.openSeriesFolder(
        folderButton.dataset.slug,
      );
    }
  });

  $("#reader-series").addEventListener("change", () => {
    const slug = $("#reader-series").value;
    populateReaderEpisodes(slug);
    $("#reader-canvas").innerHTML = "";
    $("#reader-canvas").classList.remove("active");
    $("#reader-empty").style.display = "grid";
  });

  $("#reader-episode").addEventListener("change", async () => {
    await loadReaderEpisode(
      $("#reader-series").value,
      $("#reader-episode").value,
    );
  });

  $("#reader-prev").addEventListener("click", () => {
    moveReaderEpisode(-1);
  });

  $("#reader-next").addEventListener("click", () => {
    moveReaderEpisode(1);
  });

  $("#reader-top").addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("#reader-width").addEventListener("input", () => {
    $("#reader-canvas").style.setProperty(
      "--reader-width",
      `${$("#reader-width").value}px`,
    );
  });

  $("#export-button").addEventListener(
    "click",
    exportReader,
  );

  $("#choose-library").addEventListener("click", async () => {
    const result = await window.tokiAPI.chooseLibrary();

    if (!result.cancelled) {
      $("#library-path").textContent = result.libraryRoot;
      await refreshLibrary();
      showToast("보관함 위치를 변경했습니다.", "success");
    }
  });

  $("#open-library-top").addEventListener(
    "click",
    () => window.tokiAPI.openLibrary(),
  );

  $("#open-library-settings").addEventListener(
    "click",
    () => window.tokiAPI.openLibrary(),
  );

  $("#show-worker").addEventListener(
    "click",
    () => window.tokiAPI.toggleWorkerWindow(true),
  );

  $("#hide-worker").addEventListener(
    "click",
    () => window.tokiAPI.toggleWorkerWindow(false),
  );
}

initialize();
