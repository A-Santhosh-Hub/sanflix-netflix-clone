(function () {
            'use strict';
            const {readStore, writeStore, streamURL, requestJSON, escapeHTML, displayTitle} = Sanflix;
            // ─── State ───
            const mediaId = document.getElementById('player-config').dataset.mediaId;
            let mediaData = null;
            let allMedia = [];
            let isPlaying = false;
            let controlsTimeout = null;
            let speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
            let currentSpeedIndex = 3;
            let isTranscoded = false;
            let forceTranscode = false;
            let pendingResume = 0;
            let finished = false;
            let streamStrategy = 'direct'; // 'direct', 'remux', or 'transcode'
            let totalDuration = 0;
            let streamOffset = 0;
            let saveProgressTimer = null;
            let lastDoubleTap = { time: 0, side: null };
            let hlsInstance = null;       // hls.js instance
            let hlsMode = false;           // True when playing via HLS
            let hlsPollTimer = null;
            let nextTimer = null;
            let liveMaxHeight = 1080;
            let audioTracks = [];
            let selectedAudio = null;
            let audioRequest = 0;
            let autoplayAfterLoad = true;

            // ─── Elements ───
            const video = document.getElementById('video');
            const controls = document.getElementById('player-controls');
            const loading = document.getElementById('player-loading');
            const loadingBrand = document.querySelector('.loading-brand');
            const progressBar = document.getElementById('progress-bar');
            const progressFilled = document.getElementById('progress-filled');
            const progressBuffered = document.getElementById('progress-buffered');
            const progressThumb = document.getElementById('progress-thumb');
            const progressTooltip = document.getElementById('progress-tooltip');
            const timeCurrent = document.getElementById('time-current');
            const timeTotal = document.getElementById('time-total');
            const centerIndicator = document.getElementById('center-indicator');
            const centerIcon = document.getElementById('center-icon');

            // Loading hint text
            function setLoadingHint(text) {
                let hint = document.getElementById('loading-hint');
                if (!hint) {
                    hint = document.createElement('div');
                    hint.id = 'loading-hint';
                    hint.style.cssText = 'color: rgba(255,255,255,0.5); font-size: 0.85rem; font-family: Inter, sans-serif; margin-top: 8px;';
                    loading.appendChild(hint);
                }
                hint.textContent = text;
            }

            // ─── Initialize ───
            async function init() {
                try {
                    const [item, library, initialStreamInfo] = await Promise.all([
                        requestJSON('/api/media/' + mediaId),
                        requestJSON('/api/media'),
                        requestJSON('/api/stream-info/' + mediaId)
                    ]);
                    mediaData = item;
                    allMedia = library;
                    let streamInfo = initialStreamInfo;
                    audioTracks = streamInfo.audio_tracks || [];
                    selectedAudio = streamInfo.selected_audio_index ?? null;
                    const savedAudio = readStore('sanflix_audio_tracks', {})[mediaId];
                    if (audioTracks.some(track => track.index === savedAudio) && savedAudio !== selectedAudio) {
                        try {
                            streamInfo = await requestJSON('/api/stream-info/' + mediaId + '?audio=' + savedAudio);
                            selectedAudio = streamInfo.selected_audio_index;
                        } catch (_) { /* The default track remains playable if restoring a choice fails. */ }
                    }
                    streamStrategy = streamInfo.strategy || 'direct';
                    liveMaxHeight = streamInfo.live_max_height || 1080;
                    isTranscoded = streamStrategy !== 'direct';
                    totalDuration = Number(mediaData.duration_seconds) || 0;
                    const saved = readStore('sanflix_progress', {})[mediaId];
                    const startTime = saved && saved.time > 5 && saved.percent < 99 ? saved.time : 0;
                    document.getElementById('player-title').textContent = displayTitle({...mediaData, show: null});
                    const show = [mediaData.show];
                    if (mediaData.season) show.push('Season ' + mediaData.season);
                    if (mediaData.episode) show.push('Episode ' + mediaData.episode);
                    document.getElementById('player-show-info').textContent = show.filter(Boolean).join(' · ');
                    document.title = mediaData.title + ' — SANFLIX';
                    timeTotal.textContent = formatTime(totalDuration);
                    if (mediaData.media_type === 'audio') video.poster = '/static/audio.svg';
                    setupPlaybackEvents();
                    setupControls();
                    setupKeyboard();
                    setupDoubleTapSeek();
                    setupAudioTracks();
                    if (mediaData.category === 'series') setupEpisodes();
                    if (streamInfo.use_hls_auto && streamInfo.hls_playlist && supportsHLS()) {
                        playHLS(streamInfo.hls_playlist, startTime);
                    } else {
                        loadVideo(startTime);
                    }
                } catch (error) {
                    console.error('Player initialization failed:', error);
                    setLoadingHint(error.message || 'Unable to load this media. Return to the library and retry.');
                    controls.classList.add('visible');
                    document.getElementById('btn-back').onclick = () => { window.location.href = '/'; };
                }
            }

            function setupPlaybackEvents() {
                video.addEventListener('loadedmetadata', () => {
                    const duration = isTranscoded ? totalDuration : video.duration;
                    timeTotal.textContent = formatTime(Number.isFinite(duration) ? duration : totalDuration);
                    video.playbackRate = speeds[currentSpeedIndex];
                    if (!isTranscoded && pendingResume > 0 && Number.isFinite(video.duration)) {
                        video.currentTime = Math.min(pendingResume, Math.max(0, video.duration - 0.1));
                        pendingResume = 0;
                    }
                    loading.classList.add('hidden');
                });
                video.addEventListener('canplay', () => loading.classList.add('hidden'));
                video.addEventListener('waiting', () => {
                    loading.classList.remove('hidden');
                    setLoadingHint('Buffering...');
                });
                video.addEventListener('playing', () => {
                    clearTimeout(nextTimer);
                    document.getElementById('up-next').classList.add('hidden');
                    isPlaying = true;
                    finished = false;
                    updatePlayIcon();
                    loading.classList.add('hidden');
                });
                video.addEventListener('pause', () => { isPlaying = false; updatePlayIcon(); showControls(); });
                video.addEventListener('error', () => {
                    if (hlsMode) {
                        setLoadingHint('The stream could not be played. Return to the library and retry.');
                        return;
                    }
                    if (!forceTranscode && video.error && [2, 3, 4].includes(video.error.code)) {
                        const position = (isTranscoded ? streamOffset : 0) + (video.currentTime || 0);
                        forceTranscode = true;
                        streamStrategy = 'transcode';
                        isTranscoded = true;
                        loadVideo(position, autoplayAfterLoad);
                    } else {
                        openHLSPanel();
                    }
                });
            }

            function loadVideo(startTime = 0, autoplay = true) {
                finished = false;
                autoplayAfterLoad = autoplay;
                if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
                hlsMode = false;
                document.getElementById('btn-hls').classList.remove('hls-active');
                streamOffset = isTranscoded ? Math.max(0, startTime) : 0;
                pendingResume = isTranscoded ? 0 : startTime;
                document.getElementById('playback-mode').textContent = streamStrategy === 'transcode'
                    ? `Compatibility playback · up to ${liveMaxHeight}p` : 'Original video quality';
                video.preload = 'auto';
                loading.classList.remove('hidden');
                setLoadingHint(isTranscoded ? 'Preparing your video...' : 'Loading...');
                video.pause();
                video.src = streamURL(mediaData.file, streamOffset, forceTranscode, selectedAudio);
                if (autoplay) video.play().catch(() => {});
            }

            function audioQuery(index = selectedAudio) {
                return Number.isInteger(index) ? '?audio=' + index : '';
            }

            function setupAudioTracks() {
                const control = document.getElementById('audio-control');
                const select = document.getElementById('audio-track');
                control.classList.toggle('hidden', audioTracks.length < 2);
                for (const [number, track] of audioTracks.entries()) {
                    const option = document.createElement('option');
                    option.value = String(track.index);
                    // Track numbers distinguish duplicate language / commentary tracks.
                    option.textContent = `${track.label || 'Audio'} · Track ${number + 1}`;
                    select.appendChild(option);
                }
                select.value = String(selectedAudio);
                select.addEventListener('change', async () => {
                    const index = Number(select.value);
                    const request = ++audioRequest;
                    if (!audioTracks.some(track => track.index === index)) return;
                    const status = document.getElementById('audio-status');
                    if (index === selectedAudio) { status.textContent = ''; return; }
                    status.textContent = 'Changing audio…';
                    closeHLSPanel();
                    try {
                        const info = await requestJSON('/api/stream-info/' + mediaId + audioQuery(index));
                        if (request !== audioRequest) return;
                        const position = (isTranscoded ? streamOffset : 0) + (video.currentTime || 0);
                        const autoplay = !video.paused;
                        selectedAudio = info.selected_audio_index;
                        streamStrategy = forceTranscode ? 'transcode' : info.strategy;
                        isTranscoded = streamStrategy !== 'direct';
                        if (info.hls_ready && info.hls_playlist && supportsHLS()) {
                            playHLS(info.hls_playlist, position, autoplay);
                        } else {
                            loadVideo(position, autoplay);
                        }
                        const saved = readStore('sanflix_audio_tracks', {});
                        saved[mediaId] = selectedAudio;
                        writeStore('sanflix_audio_tracks', saved);
                        select.value = String(selectedAudio);
                        status.textContent = '';
                    } catch (error) {
                        if (request !== audioRequest) return;
                        select.value = String(selectedAudio);
                        status.textContent = 'Audio could not be changed. Please try again.';
                    }
                });
            }

            function seekTo(time) {
                const duration = isTranscoded ? totalDuration : video.duration;
                if (!Number.isFinite(time) || !Number.isFinite(duration)) return;
                const position = Math.max(0, Math.min(Math.max(0, duration - 0.1), time));
                if (isTranscoded) loadVideo(position, !video.paused);
                else video.currentTime = position;
            }

            function setupControls() {
                // Play/Pause
                document.getElementById('btn-playpause').addEventListener('click', togglePlay);
                document.addEventListener('pointerdown', showControls, {passive: true});
                document.addEventListener('focusin', showControls);

                // Time update
                video.addEventListener('timeupdate', () => {
                    const duration = (isTranscoded && totalDuration) ? totalDuration : video.duration;
                    if (duration) {
                        const realTime = isTranscoded ? streamOffset + video.currentTime : video.currentTime;
                        const pct = (realTime / duration) * 100;
                        progressFilled.style.width = pct + '%';
                        progressThumb.style.left = pct + '%';
                        timeCurrent.textContent = formatTime(realTime);
                        progressBar.setAttribute('aria-valuemax', String(Math.floor(duration)));
                        progressBar.setAttribute('aria-valuenow', String(Math.floor(realTime)));
                        progressBar.setAttribute('aria-valuetext', `${formatTime(realTime)} of ${formatTime(duration)}`);

                        // Debounced save progress (every 5 seconds, not every frame)
                        debouncedSaveProgress();
                    }
                });

                // Buffered
                video.addEventListener('progress', () => {
                    const duration = (isTranscoded && totalDuration) ? totalDuration : video.duration;
                    if (video.buffered.length > 0 && duration) {
                        const buffEnd = video.buffered.end(video.buffered.length - 1);
                        const realBuffEnd = isTranscoded ? streamOffset + buffEnd : buffEnd;
                        progressBuffered.style.width = (realBuffEnd / duration * 100) + '%';
                    }
                });

                // Progress bar click — seek
                progressBar.addEventListener('click', (e) => {
                    const rect = progressBar.getBoundingClientRect();
                    const pct = (e.clientX - rect.left) / rect.width;
                    const duration = (isTranscoded && totalDuration) ? totalDuration : video.duration;
                    const seekTime = pct * duration;
                    seekTo(seekTime);
                });

                // Progress bar hover tooltip
                progressBar.addEventListener('keydown', e => {
                    const duration = isTranscoded ? totalDuration : video.duration;
                    const current = (isTranscoded ? streamOffset : 0) + video.currentTime;
                    const positions = {ArrowLeft: current - 10, ArrowRight: current + 10, Home: 0, End: duration};
                    if (Object.prototype.hasOwnProperty.call(positions, e.key)) {
                        e.preventDefault(); e.stopPropagation(); seekTo(positions[e.key]); showControls();
                    }
                });
                progressBar.addEventListener('mousemove', (e) => {
                    const rect = progressBar.getBoundingClientRect();
                    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    const duration = (isTranscoded && totalDuration) ? totalDuration : video.duration;
                    const time = pct * duration;
                    progressTooltip.textContent = formatTime(time);
                    progressTooltip.style.left = (pct * 100) + '%';
                });

                // Rewind / Forward
                document.getElementById('btn-rewind').addEventListener('click', () => {
                    const realTime = isTranscoded ? streamOffset + video.currentTime : video.currentTime;
                    const seekTime = Math.max(0, realTime - 10);
                    seekTo(seekTime);
                });
                document.getElementById('btn-forward').addEventListener('click', () => {
                    const realTime = isTranscoded ? streamOffset + video.currentTime : video.currentTime;
                    const duration = (isTranscoded && totalDuration) ? totalDuration : video.duration;
                    const seekTime = Math.min(duration, realTime + 10);
                    seekTo(seekTime);
                });

                // Volume
                const volumeSlider = document.getElementById('volume-slider');
                document.getElementById('btn-volume').addEventListener('click', () => {
                    video.muted = !video.muted;
                    updateVolumeIcon();
                });
                volumeSlider.addEventListener('input', (e) => {
                    video.volume = parseFloat(e.target.value);
                    video.muted = false;
                    updateVolumeIcon();
                });

                // Speed
                document.getElementById('btn-speed').addEventListener('click', () => {
                    currentSpeedIndex = (currentSpeedIndex + 1) % speeds.length;
                    video.playbackRate = speeds[currentSpeedIndex];
                    document.getElementById('speed-display').textContent = speeds[currentSpeedIndex] + 'x';
                });

                // Fullscreen
                document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);

                // HLS button
                document.getElementById('btn-hls').addEventListener('click', openHLSPanel);

                // Back
                document.getElementById('btn-back').addEventListener('click', () => {
                    window.location.href = '/';
                });

                // Metadata panel
                document.getElementById('btn-metadata').addEventListener('click', toggleMetadata);
                document.getElementById('meta-close').addEventListener('click', () => {
                    document.getElementById('metadata-panel').classList.remove('open');
                });

                // Video ended
                video.addEventListener('ended', onVideoEnded);

                // Mouse move — show/hide controls
                document.addEventListener('mousemove', showControls);

                // Initially show controls, then auto-hide
                showControls();
            }

            function togglePlay() {
                if (video.paused) {
                    video.play().catch(() => { isPlaying = false; updatePlayIcon(); showControls(); });
                    flashIndicator('play');
                } else {
                    video.pause();
                    isPlaying = false;
                    flashIndicator('pause');
                }
                updatePlayIcon();
            }

            function updatePlayIcon() {
                document.getElementById('btn-playpause').setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
                const icon = document.getElementById('icon-play');
                if (isPlaying) {
                    icon.innerHTML = '<rect x="6" y="4" width="4" height="16" fill="currentColor"></rect><rect x="14" y="4" width="4" height="16" fill="currentColor"></rect>';
                } else {
                    icon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
                }
            }

            function updateVolumeIcon() {
                const icon = document.getElementById('icon-volume');
                if (video.muted || video.volume === 0) {
                    icon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>';
                } else {
                    icon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>';
                }
            }

            function flashIndicator(type) {
                if (type === 'play') {
                    centerIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
                } else {
                    centerIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>';
                }
                centerIndicator.classList.add('show');
                setTimeout(() => centerIndicator.classList.remove('show'), 500);
            }

            async function toggleFullscreen() {
                try {
                if (!document.fullscreenElement) {
                    if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
                    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
                } else {
                    await document.exitFullscreen();
                }
                } catch (_) { showControls(); }
            }

            function showControls() {
                controls.classList.add('visible');
                document.body.classList.add('controls-visible');
                clearTimeout(controlsTimeout);
                controlsTimeout = setTimeout(() => {
                    if (isPlaying && !document.activeElement?.closest('.player-controls') &&
                        !document.getElementById('metadata-panel').classList.contains('open') &&
                        !document.getElementById('episode-sidebar').classList.contains('open')) {
                        controls.classList.remove('visible');
                        document.body.classList.remove('controls-visible');
                        // Close panels too
                        document.getElementById('metadata-panel').classList.remove('open');
                        document.getElementById('episode-sidebar').classList.remove('open');
                    }
                }, 3000);
            }

            function toggleMetadata() {
                const panel = document.getElementById('metadata-panel');
                panel.classList.toggle('open');

                if (panel.classList.contains('open') && mediaData) {
                    document.getElementById('meta-title').textContent = mediaData.title;
                    const items = document.getElementById('meta-items');
                    items.innerHTML = '';

                    const fields = [
                        ['Duration', mediaData.duration],
                        ['Resolution', mediaData.resolution],
                        ['Bitrate', mediaData.bitrate],
                        ['Codec', mediaData.codec],
                        ['File Size', mediaData.size],
                        ['Category', mediaData.category],
                        ['Filename', mediaData.filename]
                    ];

                    if (mediaData.show) fields.unshift(['Show', mediaData.show]);
                    if (mediaData.season) fields.push(['Season', mediaData.season]);
                    if (mediaData.episode) fields.push(['Episode', mediaData.episode]);

                    fields.forEach(([label, value]) => {
                        if (value) {
                            const div = document.createElement('div');
                            div.className = 'meta-item';
                            div.innerHTML = `<span class="meta-label">${label}</span><span class="meta-value">${escapeHTML(value)}</span>`;
                            items.appendChild(div);
                        }
                    });
                }
            }

            // ─── Episodes ───
            function setupEpisodes() {
                const btnEpisodes = document.getElementById('btn-episodes');
                const btnNext = document.getElementById('btn-next');
                btnEpisodes.classList.remove('hidden');

                // Find next episode
                const nextEp = findNextEpisode();
                if (nextEp) {
                    btnNext.classList.remove('hidden');
                    btnNext.addEventListener('click', () => {
                        window.location.href = `/player/${nextEp.id}`;
                    });
                }

                btnEpisodes.addEventListener('click', toggleEpisodeSidebar);
                document.getElementById('ep-close').addEventListener('click', () => {
                    document.getElementById('episode-sidebar').classList.remove('open');
                });
            }

            function findNextEpisode() {
                if (!mediaData.show) return null;
                const showEps = allMedia.filter(m =>
                    m.category === 'series' &&
                    m.show && mediaData.show && m.show.toLowerCase() === mediaData.show.toLowerCase()
                ).sort((a, b) => {
                    if ((a.season || 0) !== (b.season || 0)) return (a.season || 0) - (b.season || 0);
                    return (a.episode || 0) - (b.episode || 0);
                });

                const idx = showEps.findIndex(e => e.id === mediaData.id);
                return idx >= 0 && idx < showEps.length - 1 ? showEps[idx + 1] : null;
            }

            function toggleEpisodeSidebar() {
                const sidebar = document.getElementById('episode-sidebar');
                sidebar.classList.toggle('open');

                if (sidebar.classList.contains('open')) {
                    document.getElementById('ep-show-name').textContent = mediaData.show || '';
                    document.getElementById('ep-now-playing').textContent =
                        `Now playing: S${mediaData.season || '?'} E${mediaData.episode || '?'}`;

                    const showEps = allMedia.filter(m =>
                        m.category === 'series' &&
                        m.show && mediaData.show && m.show.toLowerCase() === mediaData.show.toLowerCase()
                    );

                    // Group by season
                    const seasons = {};
                    showEps.forEach(ep => {
                        const s = ep.season || 1;
                        if (!seasons[s]) seasons[s] = [];
                        seasons[s].push(ep);
                    });

                    const list = document.getElementById('ep-seasons-list');
                    list.innerHTML = '';

                    Object.keys(seasons).sort((a, b) => a - b).forEach(s => {
                        const group = document.createElement('div');
                        group.className = 'season-group';
                        group.innerHTML = `<div class="season-label">Season ${s}</div>`;

                        seasons[s].sort((a, b) => (a.episode || 0) - (b.episode || 0)).forEach(ep => {
                            const item = document.createElement('button');
                            item.className = 'ep-item' + (ep.id === mediaData.id ? ' active' : '');
                            item.innerHTML = `
                            <span class="ep-number">${ep.episode || '?'}</span>
                            <div class="ep-details">
                                <div class="ep-title">${escapeHTML(ep.title)}</div>
                                <div class="ep-duration">${ep.duration}</div>
                            </div>
                        `;
                            item.addEventListener('click', () => {
                                window.location.href = `/player/${ep.id}`;
                            });
                            group.appendChild(item);
                        });

                        list.appendChild(group);
                    });
                }
            }

            function onVideoEnded() {
                finished = true;
                if (saveProgressTimer) clearTimeout(saveProgressTimer);
                saveProgressTimer = null;
                // Clear saved progress
                const progress = readStore('sanflix_progress', {});
                delete progress[mediaId];
                writeStore('sanflix_progress', progress);

                // Add to history
                addToHistory();

                // Give viewers a visible, cancellable transition to the next episode.
                const nextEp = findNextEpisode();
                if (nextEp) {
                    document.getElementById('up-next').classList.remove('hidden');
                    document.getElementById('up-next-title').textContent = nextEp.title;
                    const playNext = () => {
                        clearTimeout(nextTimer);
                        window.location.href = `/player/${nextEp.id}`;
                    };
                    document.getElementById('up-next-play').onclick = playNext;
                    document.getElementById('up-next-cancel').onclick = () => {
                        clearTimeout(nextTimer); document.getElementById('up-next').classList.add('hidden');
                    };
                    nextTimer = setTimeout(playNext, 10000);
                }
                showControls();
            }

            // ─── Progress & History ───
            function debouncedSaveProgress() {
                if (saveProgressTimer) return;
                saveProgressTimer = setTimeout(() => {
                    saveProgress();
                    saveProgressTimer = null;
                }, 5000);
            }

            function saveProgress() {
                if (!mediaData || finished || video.ended) return;
                const duration = (isTranscoded && totalDuration) ? totalDuration : video.duration;
                if (!Number.isFinite(duration) || duration < 10) return;
                const progress = readStore('sanflix_progress', {});
                const realTime = isTranscoded ? streamOffset + video.currentTime : video.currentTime;
                progress[mediaId] = {
                    time: realTime,
                    duration: duration,
                    percent: (realTime / duration) * 100,
                    title: mediaData.title,
                    thumbnail: mediaData.thumbnail,
                    timestamp: Date.now()
                };
                writeStore('sanflix_progress', progress);

                // Also update history
                addToHistory();
            }

            function addToHistory() {
                const history = readStore('sanflix_history', []);
                const existing = history.findIndex(h => h.id === mediaId);
                if (existing >= 0) history.splice(existing, 1);
                history.unshift({
                    id: mediaId,
                    title: mediaData.title,
                    thumbnail: mediaData.thumbnail,
                    timestamp: Date.now()
                });
                // Keep last 50
                if (history.length > 50) history.length = 50;
                writeStore('sanflix_history', history);
            }

            // ─── Keyboard Shortcuts ───
            function setupKeyboard() {
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') {
                        if (document.getElementById('hls-panel').classList.contains('show')) { closeHLSPanel(); return; }
                        for (const id of ['metadata-panel', 'episode-sidebar']) {
                            const panel = document.getElementById(id);
                            if (panel.classList.contains('open')) { panel.classList.remove('open'); showControls(); return; }
                        }
                    }
                    if (e.target?.closest('input, select, textarea, button, [role="slider"]')) return;
                    switch (e.key) {
                        case ' ':
                        case 'k':
                            e.preventDefault();
                            togglePlay();
                            break;
                        case 'f':
                        case 'F':
                            e.preventDefault();
                            toggleFullscreen();
                            break;
                        case 'ArrowLeft':
                            e.preventDefault();
                            if (isTranscoded) {
                                document.getElementById('btn-rewind').click();
                            } else {
                                video.currentTime = Math.max(0, video.currentTime - 10);
                            }
                            showControls();
                            break;
                        case 'ArrowRight':
                            e.preventDefault();
                            if (isTranscoded) {
                                document.getElementById('btn-forward').click();
                            } else {
                                video.currentTime = Math.min(video.duration, video.currentTime + 10);
                            }
                            showControls();
                            break;
                        case 'ArrowUp':
                            e.preventDefault();
                            video.volume = Math.min(1, video.volume + 0.1);
                            document.getElementById('volume-slider').value = video.volume;
                            updateVolumeIcon();
                            showControls();
                            break;
                        case 'ArrowDown':
                            e.preventDefault();
                            video.volume = Math.max(0, video.volume - 0.1);
                            document.getElementById('volume-slider').value = video.volume;
                            updateVolumeIcon();
                            showControls();
                            break;
                        case 'm':
                        case 'M':
                            video.muted = !video.muted;
                            updateVolumeIcon();
                            break;
                        case 'Escape':
                            if (document.fullscreenElement) {
                                document.exitFullscreen();
                            } else {
                                window.location.href = '/';
                            }
                            break;
                    }
                });
            }

            // ─── Double-Tap to Seek ───
            function setupDoubleTapSeek() {
                const wrapper = document.getElementById('player-wrapper');
                const flashLeft = document.getElementById('seek-flash-left');
                const flashRight = document.getElementById('seek-flash-right');
                let clickTimer = null;
                let pendingSide = null;

                wrapper.addEventListener('click', (e) => {
                    // Ignore clicks on controls
                    if (e.target.closest('.player-controls') || e.target.closest('.ctrl-btn')) return;

                    const rect = wrapper.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const side = x < rect.width / 3 ? 'left' : x > rect.width * 2 / 3 ? 'right' : 'center';

                    if (clickTimer && pendingSide === side && side !== 'center') {
                        clearTimeout(clickTimer); clickTimer = null; pendingSide = null;
                        const current = (isTranscoded ? streamOffset : 0) + video.currentTime;
                        seekTo(current + (side === 'left' ? -10 : 10));
                        const flash = side === 'left' ? flashLeft : flashRight;
                        flash.classList.add('show'); setTimeout(() => flash.classList.remove('show'),400);
                        showControls();
                    } else {
                        clearTimeout(clickTimer); pendingSide = side;
                        clickTimer = setTimeout(() => { clickTimer = null; pendingSide = null; togglePlay(); showControls(); },250);
                    }
                });
            }

            // ─── Utility ───
            function formatTime(seconds) {
                if (!seconds || isNaN(seconds)) return '0:00';
                const h = Math.floor(seconds / 3600);
                const m = Math.floor((seconds % 3600) / 60);
                const s = Math.floor(seconds % 60);
                if (h > 0) {
                    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
                }
                return `${m}:${s.toString().padStart(2, '0')}`;
            }

            // ─── HLS Streaming ───────────────────────────────────────────────
            // HLS works over Cloudflare tunnels because it uses small individual
            // HTTP requests instead of one massive chunked streaming response.

            function openHLSPanel() {
                const panel = document.getElementById('hls-panel');
                panel.classList.add('show');
                // Reset to initial state
                if (hlsPollTimer) clearInterval(hlsPollTimer);
                hlsPollTimer = null;
                document.getElementById('hls-panel-title').textContent = 'Prepared playback';
                document.getElementById('hls-panel-desc').textContent =
                    'Prepare this video once to avoid live conversion while watching. This also works locally. Completed conversions are reused.';
                document.getElementById('btn-hls-start').onclick = startHLS;
                document.getElementById('btn-hls-start').disabled = false;
                document.getElementById('btn-hls-start').textContent = '▶ Start Converting';
                document.getElementById('hls-progress-bar').style.display = 'none';
                document.getElementById('hls-progress-fill').style.width = '0%';
                document.getElementById('hls-progress-fill').classList.remove('done');
                document.getElementById('hls-status-text').textContent = '';
                // Check if already converting/ready
                checkHLSStatus(false);
            }

            function closeHLSPanel() {
                document.getElementById('hls-panel').classList.remove('show');
                if (hlsPollTimer) clearInterval(hlsPollTimer);
            }

            async function startHLS() {
                const audio = selectedAudio;
                const generation = audioRequest;
                const btn = document.getElementById('btn-hls-start');
                btn.disabled = true;
                btn.textContent = '⏳ Starting...';
                document.getElementById('hls-status-text').textContent = 'Requesting conversion...';
                document.getElementById('hls-progress-bar').style.display = 'block';
                document.getElementById('hls-progress-fill').style.width = '5%';

                try {
                    const data = await requestJSON('/api/hls/start/' + mediaId + audioQuery(audio), {method: 'POST'});
                    if (audio !== selectedAudio || generation !== audioRequest) return;

                    if (data.status === 'ready') {
                        playHLS(data.playlist);
                        return;
                    }

                    // Start polling for progress
                    document.getElementById('hls-panel-title').textContent = 'Converting...';
                    document.getElementById('hls-panel-desc').textContent =
                        'Preparing your video. Long or 4K movies can take a while. Playback will start when the complete stream is ready.';
                    btn.textContent = 'Converting...';

                    if (hlsPollTimer) clearInterval(hlsPollTimer);
                    hlsPollTimer = setInterval(pollHLSStatus, 3000);

                } catch (err) {
                    if (audio !== selectedAudio || generation !== audioRequest) return;
                    btn.disabled = false;
                    btn.textContent = '▶ Start Converting';
                    document.getElementById('hls-status-text').textContent = 'Error: ' + err.message;
                }
            }

            async function checkHLSStatus(autoPlay) {
                const audio = selectedAudio;
                const generation = audioRequest;
                try {
                    const data = await requestJSON('/api/hls/status/' + mediaId + audioQuery(audio));
                    if (audio !== selectedAudio || generation !== audioRequest) return;
                    if (data.status === 'ready') {
                        document.getElementById('hls-panel-title').textContent = 'Ready to Stream!';
                        document.getElementById('hls-panel-desc').textContent =
                            'Conversion complete. Click Play to start watching in HLS mode.';
                        document.getElementById('btn-hls-start').textContent = '▶ Play (HLS)';
                        document.getElementById('btn-hls-start').disabled = false;
                        document.getElementById('btn-hls-start').onclick = () => {
                            if (audio === selectedAudio && generation === audioRequest) playHLS(data.playlist);
                        };
                        document.getElementById('hls-progress-bar').style.display = 'block';
                        document.getElementById('hls-progress-fill').style.width = '100%';
                        document.getElementById('hls-progress-fill').classList.add('done');
                        if (autoPlay) playHLS(data.playlist);
                    } else if ((data.status === 'processing' || data.status === 'queued')) {
                        // Already running — update UI
                        document.getElementById('hls-panel-title').textContent = 'Converting...';
                        document.getElementById('hls-panel-desc').textContent =
                            `FFmpeg is processing. ${data.segments_ready || 0} segments ready so far. Please wait...`;
                        document.getElementById('btn-hls-start').textContent = 'Converting...';
                        document.getElementById('btn-hls-start').disabled = true;
                        document.getElementById('hls-progress-bar').style.display = 'block';
                        document.getElementById('hls-progress-fill').style.width =
                            Math.min(95, 10 + (data.segments_ready || 0) * 2) + '%';
                        if (hlsPollTimer) clearInterval(hlsPollTimer);
                        hlsPollTimer = setInterval(pollHLSStatus, 3000);
                    }
                } catch(error) {
                    if (audio !== selectedAudio || generation !== audioRequest) return;
                    if (hlsPollTimer) clearInterval(hlsPollTimer);
                    document.getElementById('hls-status-text').textContent = error.message;
                    document.getElementById('btn-hls-start').disabled = false;
                }
            }

            async function pollHLSStatus() {
                const audio = selectedAudio;
                const generation = audioRequest;
                try {
                    const data = await requestJSON('/api/hls/status/' + mediaId + audioQuery(audio));
                    if (audio !== selectedAudio || generation !== audioRequest) return;

                    if (data.status === 'ready') {
                        clearInterval(hlsPollTimer);
                        hlsPollTimer = null;
                        // Auto-play HLS
                        playHLS(data.playlist);
                    } else if ((data.status === 'processing' || data.status === 'queued')) {
                        const segs = data.segments_ready || 0;
                        const elapsed = data.elapsed_seconds || 0;
                        document.getElementById('hls-status-text').textContent =
                            `${segs} segments ready · ${Math.floor(elapsed/60)}m ${elapsed%60}s elapsed`;
                        document.getElementById('hls-progress-fill').style.width =
                            Math.min(95, 10 + segs * 2) + '%';
                    } else if (data.status === 'error') {
                        clearInterval(hlsPollTimer);
                        document.getElementById('hls-status-text').textContent =
                            data.error || 'Conversion failed. Please retry.';
                        document.getElementById('btn-hls-start').disabled = false;
                        document.getElementById('btn-hls-start').textContent = '▶ Retry';
                    }
                } catch(error) {
                    if (audio !== selectedAudio || generation !== audioRequest) return;
                    if (hlsPollTimer) clearInterval(hlsPollTimer);
                    document.getElementById('hls-status-text').textContent = error.message;
                    document.getElementById('btn-hls-start').disabled = false;
                }
            }

            function supportsHLS() {
                return Boolean(video.canPlayType('application/vnd.apple.mpegurl') ||
                    (window.Hls && Hls.isSupported()));
            }

            function playHLS(playlistUrl, startTime = null, autoplay = true) {
                const position = startTime === null
                    ? (isTranscoded ? streamOffset : 0) + (video.currentTime || 0) : startTime;
                closeHLSPanel();
                if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
                hlsMode = true;
                autoplayAfterLoad = autoplay;
                isTranscoded = false;
                finished = false;
                streamOffset = 0;
                pendingResume = Math.max(0, position);
                document.getElementById('btn-hls').classList.add('hls-active');
                document.getElementById('playback-mode').textContent = 'Prepared playback · HLS';
                loading.classList.remove('hidden');
                setLoadingHint('Loading your stream...');
                video.pause();
                video.removeAttribute('src');
                video.load();
                // Native HLS works even if the JavaScript library is unavailable.
                if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = playlistUrl;
                    if (autoplay) video.play().catch(() => {});
                } else if (window.Hls && Hls.isSupported()) {
                    hlsInstance = new Hls({maxBufferLength: 30, maxMaxBufferLength: 60,
                        enableWorker: true, lowLatencyMode: false, startPosition: pendingResume});
                    hlsInstance.loadSource(playlistUrl);
                    hlsInstance.attachMedia(video);
                    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
                        if (autoplay) video.play().catch(() => {});
                    });
                    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
                        if (data.fatal) {
                            setLoadingHint('Unable to load this stream. Return to the library and retry.');
                            loading.classList.remove('hidden');
                        }
                    });
                } else {
                    setLoadingHint('Streaming support is unavailable. Reload this page or try another browser.');
                }
            }

            // Save on page exit
            window.addEventListener('beforeunload', () => {
                saveProgress();
                if (hlsInstance) hlsInstance.destroy();
            });

            // ─── Expose HLS functions to global scope ───
            // Required because the HTML buttons use onclick="startHLS()" which
            // needs window-level access — these are defined inside the IIFE above.
            window.startHLS = startHLS;
            window.openHLSPanel = openHLSPanel;
            window.closeHLSPanel = closeHLSPanel;

            // ─── Init ───
            init();
        })();
