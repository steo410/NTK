const { contextBridge, ipcRenderer } = require("electron");

function readOptionalEpisodeBound(id, payloadValue) {
  const input = document.getElementById(id);

  if (input && input.value.trim() === "") {
    return undefined;
  }

  return payloadValue;
}

function ensureHiddenPastedUrlsInput() {
  if (document.getElementById("pasted-urls")) return;

  const hiddenInput = document.createElement("textarea");
  hiddenInput.id = "pasted-urls";
  hiddenInput.hidden = true;
  hiddenInput.value = "";
  document.body.appendChild(hiddenInput);
}

function rewriteRequestedUiText() {
  const pageTitle = document.getElementById("page-title");

  if (pageTitle?.textContent.trim() === "세로 스크롤 리더") {
    pageTitle.textContent = "리더";
  }
}

function injectLibraryDeleteButtons() {
  for (const card of document.querySelectorAll(".library-card")) {
    if (card.querySelector(".delete-series")) continue;

    const sourceButton =
      card.querySelector(".open-series-folder") ||
      card.querySelector(".read-series");

    if (!sourceButton?.dataset.slug) continue;

    const title =
      card.querySelector("h3")?.textContent.trim() ||
      sourceButton.dataset.slug;
    const button = document.createElement("button");

    button.className = "button danger delete-series";
    button.dataset.slug = sourceButton.dataset.slug;
    button.dataset.title = title;
    button.textContent = "삭제";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const result = await ipcRenderer.invoke(
        "library:delete-series",
        button.dataset.slug,
        button.dataset.title,
      );

      if (result?.deleted) {
        document.getElementById("refresh-library")?.click();
      }
    });

    const buttons = card.querySelector(".library-buttons");

    if (buttons) {
      buttons.style.gridTemplateColumns = "1fr auto auto";
      buttons.appendChild(button);
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  ensureHiddenPastedUrlsInput();
  rewriteRequestedUiText();
  injectLibraryDeleteButtons();

  const minInput = document.getElementById("min-episode");
  const maxInput = document.getElementById("max-episode");

  if (minInput) {
    minInput.value = "";
    minInput.placeholder = "비워두면 첫 회차부터";
  }

  if (maxInput) {
    maxInput.value = "";
    maxInput.placeholder = "비워두면 최신 회차까지";
  }

  const exportPanel = document.getElementById("tab-export");

  if (exportPanel) {
    const eyebrow = exportPanel.querySelector(".eyebrow");
    const heading = exportPanel.querySelector("h2");
    const description = exportPanel.querySelector("p");
    const button = document.getElementById("export-button");
    const resultBox = document.getElementById("export-result");

    if (eyebrow) eyebrow.textContent = "PDF EXPORT";
    if (heading) heading.textContent = "회차별 PDF 내보내기";
    if (description) {
      description.textContent =
        "저장한 이미지를 회차별 PDF로 묶습니다. 이미지 한 장이 PDF 한 페이지에 비율을 유지한 채 들어갑니다.";
    }
    if (button) button.textContent = "PDF 내보내기";
    if (resultBox) resultBox.textContent = "아직 내보낸 PDF가 없습니다.";
  }

  // 보관함 카드가 나중에 렌더링될 때 삭제 버튼만 한 번 추가합니다.
  // 기존 버전처럼 textContent를 계속 다시 쓰지 않으므로 무한 MutationObserver 루프가 발생하지 않습니다.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;

    requestAnimationFrame(() => {
      scheduled = false;
      rewriteRequestedUiText();
      injectLibraryDeleteButtons();
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
});

contextBridge.exposeInMainWorld("tokiAPI", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  chooseLibrary: () => ipcRenderer.invoke("settings:choose-library"),
  openLibrary: () => ipcRenderer.invoke("settings:open-library"),

  scanSource: (payload) =>
    ipcRenderer.invoke("crawler:scan", {
      ...payload,
      minEpisode: readOptionalEpisodeBound(
        "min-episode",
        payload.minEpisode,
      ),
      maxEpisode: readOptionalEpisodeBound(
        "max-episode",
        payload.maxEpisode,
      ),
    }),
  startDownload: (payload) => ipcRenderer.invoke("crawler:start", payload),
  cancelDownload: () => ipcRenderer.invoke("crawler:cancel"),
  toggleWorkerWindow: (show) =>
    ipcRenderer.invoke("crawler:toggle-window", show),

  listLibrary: () => ipcRenderer.invoke("library:list"),
  getEpisodeImages: (seriesSlug, episodeNumber) =>
    ipcRenderer.invoke(
      "library:episode-images",
      seriesSlug,
      episodeNumber,
    ),
  openSeriesFolder: (seriesSlug) =>
    ipcRenderer.invoke("library:open-series", seriesSlug),
  deleteSeries: (seriesSlug, seriesTitle) =>
    ipcRenderer.invoke(
      "library:delete-series",
      seriesSlug,
      seriesTitle,
    ),

  exportStaticReader: (seriesSlug) =>
    ipcRenderer.invoke("export:pdf", seriesSlug),

  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("crawler:progress", listener);

    return () => {
      ipcRenderer.removeListener("crawler:progress", listener);
    };
  },
});
