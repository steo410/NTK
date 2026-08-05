const { contextBridge, ipcRenderer } = require("electron");

function readOptionalEpisodeBound(id, payloadValue) {
  const input = document.getElementById(id);

  if (input && input.value.trim() === "") {
    return undefined;
  }

  return payloadValue;
}

window.addEventListener("DOMContentLoaded", () => {
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

  const rewritePdfMessages = () => {
    for (const element of document.querySelectorAll(
      "#export-result, #toast-container .toast, #global-status",
    )) {
      element.textContent = element.textContent
        .replace("배포용 리더 폴더를 만들었습니다.", "회차별 PDF를 만들었습니다.")
        .replace("리더 내보내는 중", "PDF 만드는 중");
    }
  };

  const observer = new MutationObserver(rewritePdfMessages);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
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
