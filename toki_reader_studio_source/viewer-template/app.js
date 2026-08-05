let data = null;
let currentIndex = 0;

const reader = document.querySelector("#reader");
const select = document.querySelector("#episode-select");

async function initialize() {
  const response = await fetch("./data.json");
  data = await response.json();

  document.title = `${data.title} · Reader`;
  document.querySelector("#series-title").textContent = data.title;

  select.innerHTML = data.episodes
    .map(
      (episode, index) => `
        <option value="${index}">
          ${episode.number}화
        </option>
      `,
    )
    .join("");

  select.addEventListener("change", () => {
    loadEpisode(Number(select.value));
  });

  document.querySelector("#prev-button").addEventListener(
    "click",
    () => loadEpisode(currentIndex - 1),
  );

  document.querySelector("#next-button").addEventListener(
    "click",
    () => loadEpisode(currentIndex + 1),
  );

  document.querySelector("#top-button").addEventListener(
    "click",
    () => window.scrollTo({ top: 0, behavior: "smooth" }),
  );

  document.querySelector("#width-control").addEventListener(
    "input",
    (event) => {
      reader.style.setProperty(
        "--reader-width",
        `${event.target.value}px`,
      );
    },
  );

  loadEpisode(0);
}

function loadEpisode(index) {
  if (!data || index < 0 || index >= data.episodes.length) {
    return;
  }

  currentIndex = index;
  const episode = data.episodes[index];

  select.value = String(index);
  document.querySelector("#episode-title").textContent =
    `${episode.number}화 · ${episode.images.length}장`;

  reader.innerHTML = "";

  for (const source of episode.images) {
    const image = document.createElement("img");
    image.src = source;
    image.loading = "lazy";
    image.alt = `${episode.number}화`;
    reader.appendChild(image);
  }

  window.scrollTo({ top: 0, behavior: "instant" });
}

initialize();
