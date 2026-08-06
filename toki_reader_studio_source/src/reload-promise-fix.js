const { app } = require('electron');

// Electron의 reloadIgnoringCache()는 일부 버전에서 Promise를 반환하지 않습니다.
// 기존 스캐너가 안전하게 await ... .catch(...)를 사용할 수 있도록
// 새로 만들어지는 WebContents 인스턴스의 반환값만 Promise로 정규화합니다.
app.on('web-contents-created', (_event, contents) => {
  if (!contents || typeof contents.reloadIgnoringCache !== 'function') {
    return;
  }

  const originalReloadIgnoringCache =
    contents.reloadIgnoringCache.bind(contents);

  contents.reloadIgnoringCache = () => {
    try {
      const result = originalReloadIgnoringCache();

      if (result && typeof result.then === 'function') {
        return result;
      }

      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  };
});
