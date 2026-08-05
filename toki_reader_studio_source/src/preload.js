const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tokiAPI", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  chooseLibrary: () => ipcRenderer.invoke("settings:choose-library"),
  openLibrary: () => ipcRenderer.invoke("settings:open-library"),

  scanSource: (payload) => ipcRenderer.invoke("crawler:scan", payload),
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
    ipcRenderer.invoke("export:static-reader", seriesSlug),

  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("crawler:progress", listener);

    return () => {
      ipcRenderer.removeListener("crawler:progress", listener);
    };
  },
});
