/* Catalog presentation; streaming and administration stay in their own modules. */
(function () {
  "use strict";
  const {
    readStore,
    writeStore,
    requestJSON,
    pathURL,
    escapeHTML: esc,
    displayTitle,
    durationLabel,
    qualityLabel,
    groupTitles,
  } = Sanflix;
  const $ = (id) => document.getElementById(id);
  let media = [],
    titles = [],
    favorites = [],
    progress = {},
    history = [];
  let filter = "all",
    query = "",
    sort = "default",
    featured = [],
    heroIndex = 0;
  let failed = false,
    modalItem = null,
    returnFocus = null,
    toastTimer;
  const names = {
    all: "Your next great watch",
    movie: "Movies",
    series: "TV Shows",
    music: "Music",
    favorites: "My List",
  };
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true">${{ play: '<path d="m8 4 13 8-13 8Z" fill="currentColor" stroke="none"/>', plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="m5 12 4 4L19 6"/>' }[name]}</svg>`;
  function readState() {
    favorites = readStore("sanflix_favorites", []);
    progress = readStore("sanflix_progress", {});
    history = readStore("sanflix_history", []);
  }
  function episodes(item) {
    return item.episodes || [item];
  }
  function listTitle(item) {
    return item.category === "series" && item.show
      ? titles.find(
          (title) => title.show?.toLowerCase() === item.show.toLowerCase(),
        ) || item
      : item;
  }
  function saved(item) {
    return episodes(listTitle(item)).some((ep) => favorites.includes(ep.id));
  }
  function playable(item) {
    return (
      episodes(item)
        .filter(
          (ep) => progress[ep.id]?.percent > 2 && progress[ep.id]?.percent < 95,
        )
        .sort(
          (a, b) =>
            (progress[b.id].timestamp || 0) - (progress[a.id].timestamp || 0),
        )[0] || episodes(item)[0]
    );
  }
  function playLabel(item) {
    const p = progress[playable(item).id];
    return p?.percent > 2 && p?.percent < 95 ? "Resume" : "Play";
  }
  function play(item) {
    window.location.href = `/player/${playable(item).id}`;
  }
  function metadata(item) {
    const count = item.episodes?.length;
    return [
      item.category === "series"
        ? "TV Show"
        : item.category === "music"
          ? item.media_type === "audio"
            ? "Audio"
            : "Music video"
          : "Movie",
      count ? `${count} episode${count === 1 ? "" : "s"}` : durationLabel(item),
      qualityLabel(item),
    ].filter(Boolean);
  }
  function sorted(items) {
    const result = [...items];
    if (sort === "az" || sort === "za")
      result.sort(
        (a, b) =>
          displayTitle(a).localeCompare(displayTitle(b)) *
          (sort === "az" ? 1 : -1),
      );
    if (sort === "short")
      result.sort(
        (a, b) =>
          (a.duration_seconds || Infinity) - (b.duration_seconds || Infinity),
      );
    return result;
  }
  function notify(message) {
    $("toast").textContent = message;
    $("toast").classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 2600);
  }
  function toggleFavorite(item) {
    item = listTitle(item);
    const remove = saved(item),
      ids = episodes(item).map((ep) => ep.id);
    favorites = favorites.filter((id) => !ids.includes(id));
    if (!remove) favorites.push(item.id);
    writeStore("sanflix_favorites", favorites);
    const cardId = document.activeElement?.closest(".media-card")?.dataset.id;
    render();
    renderHero();
    if (modalItem) updateModalFavorite();
    if (cardId && !modalItem) {
      const replacement = document.querySelector(
        `.media-card[data-id="${cardId}"] .card-fav`,
      );
      (replacement || $("content")).focus();
    }
    notify(remove ? "Removed from My List" : "Added to My List");
  }
  function cardArt(item) {
    if (item.backdrop) return { src: item.backdrop, fit: false };
    if (item.poster) return { src: item.poster, fit: true };
    return { src: item.thumbnail, fit: false };
  }
  function createCard(item, continuing = false) {
    const card = document.createElement("article");
    card.className = "media-card";
    card.dataset.id = item.id;
    const title = displayTitle(item),
      pct = Math.max(0, Math.min(100, progress[item.id]?.percent || 0));
    const remaining = Math.max(
      0,
      Math.ceil(
        ((progress[item.id]?.duration || 0) - (progress[item.id]?.time || 0)) /
          60,
      ),
    );
    const art = cardArt(item);
    card.innerHTML = `<div class="card-thumbnail${art.fit ? " poster-fit" : ""}"${art.fit ? ` style="--art:url('${pathURL("/", art.src)}')"` : ""}><button class="card-open" aria-label="More info about ${esc(title)}"><span class="placeholder-thumb">${item.media_type === "audio" ? "♫" : "S"}</span>${art.src ? `<img src="${pathURL("/", art.src)}" alt="" loading="lazy" decoding="async">` : ""}<span class="card-shade"></span><span class="card-image-title">${esc(title)}</span></button>${qualityLabel(item) ? `<span class="card-quality">${qualityLabel(item)}</span>` : ""}${continuing ? `<div class="card-progress" aria-label="${Math.round(pct)}% watched"><div style="width:${pct}%"></div></div>` : ""}</div><div class="card-info"><div class="card-copy"><button class="card-title" title="${esc(title)}">${esc(title)}</button><p class="card-meta">${esc(continuing ? `${item.episode ? `S${item.season || 1} · E${item.episode} · ` : ""}${remaining} min left` : metadata(item).slice(0, 2).join(" · "))}</p></div><div class="card-actions"><button class="card-play-btn" aria-label="${playLabel(item)} ${esc(title)}">${icon("play")}</button><button class="card-fav ${saved(item) ? "active" : ""}" aria-label="${saved(item) ? "Remove from" : "Add to"} My List: ${esc(title)}" aria-pressed="${saved(item)}">${icon(saved(item) ? "check" : "plus")}</button></div></div>`;
    card
      .querySelector(".card-open")
      .addEventListener("click", () => openModal(item));
    card
      .querySelector(".card-title")
      .addEventListener("click", () => openModal(item));
    card
      .querySelector(".card-play-btn")
      .addEventListener("click", () => play(item));
    card
      .querySelector(".card-fav")
      .addEventListener("click", () => toggleFavorite(item));
    card.querySelector("img")?.addEventListener("error", (e) => {
      e.target.style.display = "none";
    });
    return card;
  }
  function row(name, items, visible, continuing = false) {
    const section = $(`${name}-section`),
      grid = $(name === "continue-watching" ? name : `${name}-grid`);
    section.style.display = "";
    section.classList.toggle("hidden", !visible || !items.length);
    grid.innerHTML = "";
    grid.classList.toggle("expanded-grid", filter !== "all");
    if (!visible) return;
    const fragment = document.createDocumentFragment();
    (filter === "all" ? items : sorted(items)).forEach((item) =>
      fragment.appendChild(createCard(item, continuing)),
    );
    grid.appendChild(fragment);
    section.querySelector(".row-count")?.remove();
    const count = document.createElement("span");
    count.className = "row-count";
    count.textContent = String(items.length);
    section.querySelector(".row-title").appendChild(count);
  }
  function empty(title, description, action) {
    $("empty-state").classList.remove("hidden");
    $("empty-title").textContent = title;
    $("empty-description").textContent = description;
    $("empty-action").classList.toggle("hidden", !action);
    $("empty-action").textContent = failed
      ? "Try again"
      : "Explore your library";
    $("empty-action").onclick = failed ? load : () => navigate("all");
  }
  function render() {
    const searching = query.length > 0,
      home = filter === "all" && !searching;
    document.body.classList.toggle(
      "browse-mode",
      !home || failed || !titles.length,
    );
    $("hero").classList.toggle("hidden", !home || failed || !titles.length);
    $("sort-control").classList.toggle(
      "hidden",
      home || failed || !titles.length,
    );
    $("browse-title").textContent = searching
      ? `Results for “${query}”`
      : names[filter];
    $("browse-eyebrow").textContent = searching
      ? "FIND SOMETHING GREAT"
      : filter === "favorites"
        ? "SAVED FOR A GOOD NIGHT"
        : home
          ? "MAKE YOURSELF AT HOME"
          : "EXPLORE YOUR LIBRARY";
    $("empty-state").classList.add("hidden");
    $("search-results").classList.toggle("hidden", !searching);
    const continuing = Object.keys(progress)
      .sort(
        (a, b) => (progress[b].timestamp || 0) - (progress[a].timestamp || 0),
      )
      .filter((id) => progress[id].percent > 2 && progress[id].percent < 95)
      .map((id) => media.find((m) => m.id === id))
      .filter(Boolean);
    row("continue-watching", continuing, home, true);
    const list = titles.filter(saved);
    row("favorites", list, !searching && (home || filter === "favorites"));
    for (const [name, category] of [
      ["movies", "movie"],
      ["series", "series"],
      ["music", "music"],
    ])
      row(
        name,
        titles.filter((m) => m.category === category),
        !searching && (home || filter === category),
      );
    row(
      "history",
      history
        .map((h) => media.find((m) => m.id === h.id))
        .filter(Boolean)
        .slice(0, 20),
      home,
    );
    let visible =
      filter === "favorites"
        ? list
        : filter === "all"
          ? titles
          : titles.filter((m) => m.category === filter);
    if (searching) {
      visible = titles.filter((item) =>
        episodes(item).some((ep) =>
          [displayTitle(item), ep.title, ep.show, ep.filename].some((value) =>
            String(value || "")
              .toLowerCase()
              .includes(query.toLowerCase()),
          ),
        ),
      );
      $("search-grid").innerHTML = "";
      sorted(visible).forEach((item) =>
        $("search-grid").appendChild(createCard(item)),
      );
    }
    $("browse-count").textContent =
      `${visible.length} title${visible.length === 1 ? "" : "s"}${home ? " in your collection" : ""}`;
    if (failed)
      empty(
        "Your library couldn’t load",
        "Check your connection and try again.",
        true,
      );
    else if (!titles.length)
      empty(
        "Your cinema starts with you",
        "Add your first movie, show or song using Manage library below.",
        false,
      );
    else if (!visible.length)
      empty(
        searching
          ? "No matches this time"
          : filter === "favorites"
            ? "Make room for your favorites"
            : "More good things to come",
        searching
          ? "Try a different title, show name or filename."
          : filter === "favorites"
            ? "Tap + on any title to save it here for later."
            : "There are no titles in this category yet.",
        true,
      );
    document.querySelectorAll(".nav-link[data-filter]").forEach((link) => {
      const active = !searching && link.dataset.filter === filter;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    $("mobile-search").classList.toggle("active", searching);
  }
  function navigate(next) {
    filter = names[next] ? next : "all";
    query = "";
    $("search-input").value = "";
    setSearch(false);
    render();
    window.scrollTo?.({ top: 0, behavior: "instant" });
    window.history?.replaceState?.(null, "", "#" + filter);
  }
  function setSearch(open) {
    $("search-container").classList.toggle("active", open);
    $("search-toggle").setAttribute("aria-expanded", String(open));
    $("search-input").tabIndex = open ? 0 : -1;
    if (open) $("search-input").focus();
  }
  function renderHero() {
    const item = featured[heroIndex];
    if (!item) return;
    $("hero-bg").style.backgroundImage = (item.backdrop || item.thumbnail)
      ? `url("${pathURL("/", item.backdrop || item.thumbnail)}")`
      : "";
    $("hero-title").textContent = displayTitle(item);
    $("hero-badge").textContent =
      item.category === "series"
        ? "SERIES SPOTLIGHT"
        : item.category === "music"
          ? "TURN IT UP"
          : "TONIGHT’S SPOTLIGHT";
    $("hero-meta").innerHTML = metadata(item)
      .map((t) => `<span>${esc(t)}</span>`)
      .join("");
    $("hero-description").textContent =
      item.description ||
      (item.category === "series"
        ? "Find your next obsession. Settle in and let the story unfold."
        : item.category === "music"
          ? "A little louder. A little closer. Your soundtrack starts here."
          : "The big-screen feeling, right where you are. Make tonight a movie night.");
    $("hero-play").innerHTML = icon("play") + playLabel(item);
    $("hero-play").disabled = false;
    $("hero-info").disabled = false;
    $("hero-play").onclick = () => play(item);
    $("hero-info").onclick = () => openModal(item);
    $("hero-position").textContent =
      `${String(heroIndex + 1).padStart(2, "0")} / ${String(featured.length).padStart(2, "0")}`;
    $("hero-pagination").classList.toggle("hidden", featured.length < 2);
  }
  function updateModalFavorite() {
    $("modal-fav").innerHTML =
      icon(saved(modalItem) ? "check" : "plus") + "My List";
    $("modal-fav").setAttribute("aria-pressed", String(saved(modalItem)));
    $("modal-fav").setAttribute(
      "aria-label",
      saved(modalItem) ? "Remove from My List" : "Add to My List",
    );
  }
  function openModal(item) {
    modalItem = item;
    returnFocus = document.activeElement;
    $("detail-modal").classList.remove("hidden");
    $("detail-modal").scrollTop = 0;
    document.body.classList.add("modal-open");
    document.querySelector(".file-details").open = false;
    $("modal-title").textContent = displayTitle(item);
    $("modal-category").textContent =
      item.category === "series"
        ? "A LITTLE MORE TO LOOK FORWARD TO"
        : "IN YOUR COLLECTION";
    $("modal-backdrop").style.backgroundImage = (item.backdrop || item.thumbnail)
      ? `url("${pathURL("/", item.backdrop || item.thumbnail)}")`
      : "";
    const poster = $("modal-poster");
    poster.classList.toggle("hidden", !item.poster);
    $("modal-body").classList.toggle("has-poster", Boolean(item.poster));
    if (item.poster) poster.src = pathURL("/", item.poster);
    $("modal-meta").textContent = metadata(item).join(" · ");
    $("modal-description").textContent =
      item.description ||
      (item.episodes
        ? `${item.episodes.length} episodes in your library. Choose a season below, or continue where you left off.`
        : "Ready when you are. Play now or save this title to My List.");
    $("modal-file").textContent = [
      item.filename || item.title,
      item.resolution,
      item.codec,
      item.size,
    ]
      .filter((v) => v && v !== "Unknown")
      .join(" · ");
    $("modal-play").innerHTML = icon("play") + playLabel(item);
    $("modal-play").onclick = () => play(item);
    $("modal-fav").onclick = () => toggleFavorite(item);
    updateModalFavorite();
    $("modal-download").onclick = () => {
      window.location.href = `/download/${playable(item).id}`;
    };
    $("modal-share").onclick = () => window.SanflixShare?.open(playable(item));
    const show = item.category === "series" && item.show;
    $("modal-episodes").classList.toggle("hidden", !show);
    if (show) {
      const full =
        titles.find((m) => m.show?.toLowerCase() === item.show.toLowerCase()) ||
        item;
      const seasons = [
        ...new Set(episodes(full).map((ep) => ep.season || 1)),
      ].sort((a, b) => a - b);
      $("season-select").innerHTML = seasons
        .map((n) => `<option value="${Number(n)}">Season ${Number(n)}</option>`)
        .join("");
      $("season-select").value = String(playable(item).season || seasons[0]);
      $("season-select").onchange = () => renderEpisodes(full);
      renderEpisodes(full);
    }
    $("modal-close").focus();
  }
  function renderEpisodes(item) {
    $("episode-list").innerHTML = "";
    episodes(item)
      .filter((ep) => String(ep.season || 1) === $("season-select").value)
      .forEach((ep) => {
        const button = document.createElement("button");
        button.className = "episode-item";
        const pct = Math.max(0, Math.min(100, progress[ep.id]?.percent || 0));
        button.innerHTML = `<span class="episode-number">${ep.episode || "–"}</span><span class="episode-art">${ep.thumbnail ? `<img src="${pathURL("/", ep.thumbnail)}" alt="" loading="lazy">` : ""}${icon("play")}</span><span class="episode-copy"><strong>${esc(ep.display_title || ep.title)}</strong><span>${esc(durationLabel(ep))}${pct > 2 ? " · Continue watching" : ""}</span>${pct > 2 ? `<span class="episode-progress"><span style="width:${pct}%"></span></span>` : ""}</span>`;
        button.addEventListener("click", () => play(ep));
        $("episode-list").appendChild(button);
      });
  }
  function closeModal() {
    $("detail-modal").classList.add("hidden");
    document.body.classList.remove("modal-open");
    modalItem = null;
    if (returnFocus?.isConnected) returnFocus.focus();
    else $("content").focus();
  }
  function setupSliders() {
    document.querySelectorAll(".card-slider").forEach((slider) => {
      const controls = document.createElement("div");
      controls.className = "row-controls";
      controls.innerHTML =
        '<button aria-label="Previous titles">‹</button><button aria-label="Next titles">›</button>';
      const [prev, next] = controls.querySelectorAll("button");
      const move = (direction) =>
        slider.scrollBy({
          left: direction * slider.clientWidth * 0.85,
          behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")
            .matches
            ? "instant"
            : "smooth",
        });
      prev.onclick = () => move(-1);
      next.onclick = () => move(1);
      const update = () => {
        prev.disabled = slider.scrollLeft < 2;
        next.disabled =
          slider.scrollLeft >= slider.scrollWidth - slider.clientWidth - 2;
      };
      slider.addEventListener("scroll", update, { passive: true });
      if (window.ResizeObserver) new ResizeObserver(update).observe(slider);
      new MutationObserver(update).observe(slider, { childList: true });
      slider.parentNode.appendChild(controls);
      update();
    });
  }
  async function load() {
    failed = false;
    $("loading-skeleton").classList.remove("hidden");
    try {
      const data = await requestJSON("/api/media");
      if (!Array.isArray(data)) throw new Error("Invalid library");
      media = data;
      titles = groupTitles(media);
      readState();
      featured = [...titles]
        .sort(
          (a, b) =>
            Number(Boolean(b.backdrop || b.thumbnail)) -
              Number(Boolean(a.backdrop || a.thumbnail)) ||
            Number(b.category === "movie") - Number(a.category === "movie") ||
            (b.duration_seconds || 0) - (a.duration_seconds || 0),
        )
        .slice(0, 6);
      heroIndex = 0;
      renderHero();
    } catch (_) {
      failed = true;
    }
    $("loading-skeleton").classList.add("hidden");
    $("content").style.display = "";
    render();
  }
  async function showNetworkLink() {
    const box = $("network-link");
    try {
      const { urls } = await requestJSON("/api/network");
      if (!Array.isArray(urls) || !urls.length) return;
      box.textContent = "On the same Wi-Fi, open ";
      urls.forEach((url, index) => {
        if (index) box.append(" or ");
        const link = document.createElement("a");
        link.href = url;
        link.textContent = url;
        box.append(link);
      });
      box.classList.remove("hidden");
    } catch (_) {}
  }
  document.addEventListener("DOMContentLoaded", () => {
    showNetworkLink();
    filter = String(window.location.hash || "").slice(1);
    if (!names[filter]) filter = "all";
    setSearch(false);
    document.querySelectorAll(".nav-link[data-filter]").forEach((link) =>
      link.addEventListener("click", (e) => {
        e.preventDefault();
        navigate(link.dataset.filter);
      }),
    );
    window.addEventListener("hashchange", () =>
      navigate(window.location.hash.slice(1)),
    );
    window.addEventListener(
      "scroll",
      () => $("navbar").classList.toggle("scrolled", window.scrollY > 24),
      { passive: true },
    );
    $("search-toggle").addEventListener("click", () => {
      const open = !$("search-container").classList.contains("active");
      if (!open) {
        query = "";
        $("search-input").value = "";
        render();
      }
      setSearch(open);
    });
    $("mobile-search").addEventListener("click", () => {
      setSearch(true);
      window.scrollTo?.({ top: 0, behavior: "instant" });
    });
    $("search-input").addEventListener("input", () => {
      query = $("search-input").value.trim();
      render();
    });
    $("search-clear").addEventListener("click", () => {
      query = "";
      $("search-input").value = "";
      render();
      $("search-input").focus();
    });
    $("search-input").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        query = "";
        $("search-input").value = "";
        setSearch(false);
        render();
        $("search-toggle").focus();
      }
    });
    $("sort-select").addEventListener("change", () => {
      sort = $("sort-select").value;
      render();
    });
    $("hero-prev").addEventListener("click", () => {
      heroIndex = (heroIndex - 1 + featured.length) % featured.length;
      renderHero();
    });
    $("hero-next").addEventListener("click", () => {
      heroIndex = (heroIndex + 1) % featured.length;
      renderHero();
    });
    $("modal-close").addEventListener("click", closeModal);
    $("detail-modal").addEventListener("click", (e) => {
      if (e.target === $("detail-modal")) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      const modal = document.querySelector(".modal-overlay:not(.hidden)");
      if (!modal) return;
      if (e.key === "Escape" && modal.id === "detail-modal") closeModal();
      if (e.key === "Tab") {
        const nodes = [
            ...modal.querySelectorAll(
              'button,a[href],input,select,summary,[tabindex="0"]',
            ),
          ].filter((el) => !el.disabled && el.getClientRects().length),
          first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    });
    window.addEventListener("storage", () => {
      readState();
      render();
      renderHero();
      if (modalItem) updateModalFavorite();
    });
    setupSliders();
    return load();
  });
})();
