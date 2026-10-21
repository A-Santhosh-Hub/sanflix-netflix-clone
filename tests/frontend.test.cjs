/* Execute the real scripts with isolated DOM/media doubles. No browser required. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, 'static', name), 'utf8');

class Element {
    constructor() {
        this.style = {}; this.dataset = {}; this.value = ''; this.textContent = '';
        this.content = 'test-csrf'; this.children = []; this.listeners = {};
        this.classes = new Set(); this.attributes = {}; this.selectors = {};
        this.classList = {
            add: (...names) => names.forEach(n => this.classes.add(n)),
            remove: (...names) => names.forEach(n => this.classes.delete(n)),
            contains: n => this.classes.has(n),
            toggle: (n, force) => {
                const add = force === undefined ? !this.classes.has(n) : force;
                add ? this.classes.add(n) : this.classes.delete(n);
                return add;
            }
        };
    }
    addEventListener(name, fn, options) { (this.listeners[name] ||= []).push({fn, once: options?.once}); }
    removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(x => x.fn !== fn); }
    async fire(name, event = {}) {
        const value = {preventDefault() {}, stopPropagation() {}, target: this, ...event};
        for (const entry of [...(this.listeners[name] || [])]) {
            if (entry.once) this.removeEventListener(name, entry.fn);
            await entry.fn(value);
        }
    }
    querySelector(selector) { return this.selectors[selector] ||= new Element(); }
    querySelectorAll() { return []; }
    appendChild(child) { this.children.push(child); return child; }
    append(child) { this.children.push(child); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; if (key === 'src') this.src = ''; }
    getBoundingClientRect() { return {left: 0, width: 100}; }
    closest() { return null; }
    focus() {}
    scrollBy() {}
    reportValidity() { return true; }
    reset() {}
    remove() {}
}

async function environment({audioTracks = [], savedAudio, strategy = 'direct', autoHLS = false, native = false, missingHLS = false, corrupt = false, blocked = false, main = false, nextEpisode = false} = {}) {
    const elements = new Map();
    const get = id => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    const item = {id: '123456abcdef', title: 'Episode 1', show: 'Test Show', category: 'series',
        season: 1, episode: 1, file: 'media/series/Test #1.mp4', duration_seconds: 1000,
        duration: '00:16:40', resolution: '1280x720', codec: 'h264', size: '10 MB', thumbnail: null};
    const stored = new Map([['sanflix_progress', JSON.stringify({[item.id]: {time: 120, duration: 1000, percent: 12}})]]);
    if (savedAudio !== undefined) stored.set('sanflix_audio_tracks', JSON.stringify({[item.id]: savedAudio}));
    const document = new Element();
    document.body = new Element();
    document.documentElement = {requestFullscreen() {}};
    document.getElementById = get;
    document.createElement = () => new Element();
    document.createDocumentFragment = () => new Element();
    document.querySelector = () => new Element();
    const nav = ['all', 'series', 'movie'].map(filter => { const node = new Element(); node.dataset.filter = filter; return node; });
    document.querySelectorAll = selector => selector.includes('.nav-link') ? nav : [];
    get('player-config').dataset.mediaId = item.id;
    const video = get('video');
    Object.assign(video, {duration: 1000, currentTime: 0, paused: true, ended: false, volume: 1,
        buffered: {length: 0}, play() { this.paused = false; return Promise.resolve(); },
        pause() { this.paused = true; }, load() {}, canPlayType() { return native ? 'probably' : ''; }});
    const timers = new Map(); let timerId = 0;
    const calls = [];
    const network = {};
    class Hls {
        static Events = {MANIFEST_PARSED: 'manifest', ERROR: 'error'};
        static isSupported() { return true; }
        constructor(options) { this.options = options; this.handlers = {}; calls.push({hls: this}); }
        loadSource(url) { this.url = url; }
        attachMedia(media) { this.media = media; }
        on(name, fn) { this.handlers[name] = fn; }
        destroy() { this.destroyed = true; }
    }
    const context = {document, console, URLSearchParams, Element,
        location: {href: '', reload() {}}, scrollY: 0,
        localStorage: {getItem(key) { if (blocked) throw new Error('blocked'); return corrupt ? '{bad' : stored.get(key) ?? null; },
            setItem(key, value) { if (blocked) throw new Error('blocked'); stored.set(key, value); }},
        fetch: async (url, options = {}) => {
            calls.push({url, options});
            let data;
            if (url === '/api/media') data = nextEpisode ? [item, {...item, id: 'next', episode: 2, title: 'Episode 2'}] : [item];
            else if (url.startsWith('/api/media/')) data = item;
            else if (url.startsWith('/api/stream-info/')) {
                const query = new URL(url, 'http://localhost').searchParams.get('audio');
                data = {strategy, use_hls_auto: autoHLS, hls_ready: autoHLS,
                    audio_tracks: audioTracks, selected_audio_index: query === null ? audioTracks[0]?.index ?? null : Number(query),
                    hls_playlist: '/hls/' + item.id + (query && query !== String(audioTracks[0]?.index) ? '/audio-' + query : '') + '/playlist.m3u8'};
                if (network.streamInfo) data = await network.streamInfo(url, data);
            }
            else if (url.startsWith('/api/hls/start/')) data = {status: 'queued'};
            else if (url.startsWith('/api/hls/status/')) data = network.hlsStatus ? await network.hlsStatus(url) : {status: 'not_started'};
            else data = {};
            return {ok: true, status: 200, json: async () => data};
        },
        setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
        clearTimeout(id) { timers.delete(id); }, setInterval() { return ++timerId; }, clearInterval() {},
        requestAnimationFrame(fn) { fn(); }, addEventListener() {},
    };
    if (!missingHLS) context.Hls = Hls;
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source('common.js'), context);
    vm.runInContext(source(main ? 'script.js' : 'player.js'), context);
    if (main) await document.fire('DOMContentLoaded');
    await new Promise(resolve => setImmediate(resolve));
    return {context, get, video, item, stored, timers, calls, nav, network};
}

const languages = [{index: 1, language: 'tam', label: 'Tamil'},
    {index: 3, language: 'eng', label: 'English'}, {index: 5, language: 'hin', label: 'Hindi'}];

test('audio menu appears only for multiple tracks and restores a valid saved choice', async () => {
    for (const audioTracks of [[], languages.slice(0, 1)]) {
        const e = await environment({audioTracks});
        assert.equal(e.get('audio-control').classList.contains('hidden'), true);
    }
    const e = await environment({audioTracks: languages, savedAudio: 3, strategy: 'remux'});
    assert.equal(e.get('audio-control').classList.contains('hidden'), false);
    assert.equal(e.get('audio-track').value, '3');
    assert.equal(e.get('audio-track').children[0].textContent, 'Tamil · Track 1');
    assert.match(e.video.src, /audio=3/);
    assert.match(e.video.src, /start=120/);
    const stale = await environment({audioTracks: languages, savedAudio: 99});
    assert.equal(stale.get('audio-track').value, '1');
});

test('changing audio retains playback position, pause state, volume, speed and future seeks', async () => {
    for (const paused of [true, false]) {
        const e = await environment({audioTracks: languages, strategy: 'remux'});
        e.video.currentTime = 25.375; // 120-second initial stream offset + elapsed time.
        e.video.paused = paused;
        e.video.volume = 0.35;
        await e.get('btn-speed').fire('click');
        const speed = e.video.playbackRate;
        e.get('audio-track').value = '3';
        await e.get('audio-track').fire('change');
        assert.match(e.video.src, /start=145.375/);
        assert.match(e.video.src, /audio=3/);
        assert.equal(e.video.paused, paused);
        assert.equal(e.video.volume, 0.35);
        await e.video.fire('loadedmetadata');
        assert.equal(e.video.playbackRate, speed);
        assert.equal(JSON.parse(e.stored.get('sanflix_audio_tracks'))[e.item.id], 3);
        e.video.currentTime = 0;
        await e.get('btn-forward').fire('click');
        assert.match(e.video.src, /audio=3/);
        assert.equal(e.video.paused, paused);
        await e.context.startHLS();
        assert.ok(e.calls.some(call => call.url?.includes('/api/hls/start/') && call.url.endsWith('?audio=3')));
    }
});

test('audio switching destroys the previous HLS player and resumes the selected cached stream', async () => {
    const e = await environment({audioTracks: languages, autoHLS: true, strategy: 'remux'});
    const original = e.calls.find(call => call.hls).hls;
    e.video.currentTime = 222.5;
    e.video.paused = true;
    e.get('audio-track').value = '3';
    await e.get('audio-track').fire('change');
    assert.equal(original.destroyed, true);
    const current = e.calls.filter(call => call.hls).at(-1).hls;
    assert.match(current.url, /audio-3\/playlist/);
    assert.equal(current.options.startPosition, 222.5);
    await current.handlers.manifest();
    assert.equal(e.video.paused, true);
    await e.video.fire('loadedmetadata');
    assert.equal(e.video.currentTime, 222.5);
});

test('switching from HLS to an unprepared audio track uses the selected live stream', async () => {
    const e = await environment({audioTracks: languages, autoHLS: true, strategy: 'remux'});
    const original = e.calls.find(call => call.hls).hls;
    e.network.streamInfo = (url, data) => ({...data, hls_ready: false, use_hls_auto: false});
    e.video.currentTime = 234.5;
    e.video.paused = false;
    e.get('audio-track').value = '5';
    await e.get('audio-track').fire('change');
    assert.equal(original.destroyed, true);
    assert.match(e.video.src, /start=234.5/);
    assert.match(e.video.src, /audio=5/);
    assert.equal(e.get('btn-hls').classList.contains('hls-active'), false);
    assert.equal(e.video.paused, false);
});

test('failed audio changes keep the playing track and rapid changes ignore stale responses', async () => {
    const e = await environment({audioTracks: languages, strategy: 'remux'});
    const original = e.video.src;
    e.network.streamInfo = () => { throw new Error('offline'); };
    e.get('audio-track').value = '3';
    await e.get('audio-track').fire('change');
    assert.equal(e.video.src, original);
    assert.equal(e.get('audio-track').value, '1');
    assert.match(e.get('audio-status').textContent, /try again/);
    const pending = [];
    e.network.streamInfo = (url, data) => new Promise(resolve => pending.push(() => resolve(data)));
    e.get('audio-track').value = '3';
    const first = e.get('audio-track').fire('change');
    e.get('audio-track').value = '5';
    const second = e.get('audio-track').fire('change');
    pending[1](); await second;
    pending[0](); await first;
    assert.match(e.video.src, /audio=5/);
    assert.equal(e.get('audio-track').value, '5');
});

test('an old HLS status response cannot switch audio back during a new selection', async () => {
    const e = await environment({audioTracks: languages, strategy: 'remux'});
    let finishStatus;
    e.network.hlsStatus = () => new Promise(resolve => { finishStatus = resolve; });
    e.context.openHLSPanel();
    let finishAudio;
    e.network.streamInfo = (url, data) => new Promise(resolve => { finishAudio = () => resolve(data); });
    e.get('audio-track').value = '3';
    const changed = e.get('audio-track').fire('change');
    finishStatus({status: 'ready', playlist: '/old-language.m3u8'});
    await new Promise(resolve => setImmediate(resolve));
    assert.notEqual(e.get('hls-panel-title').textContent, 'Ready to Stream!');
    finishAudio(); await changed;
    assert.match(e.video.src, /audio=3/);
});

test('search then category navigation restores visible sections', async () => {
    const e = await environment({main: true});
    e.get('search-input').value = 'episode';
    await e.get('search-input').fire('input');
    for (const fn of [...e.timers.values()]) fn();
    assert.equal(e.get('series-section').classList.contains('hidden'), true);
    await e.nav[1].fire('click');
    assert.equal(e.get('series-section').classList.contains('hidden'), false);
    assert.equal(e.get('series-section').style.display, '');
    assert.equal(e.get('search-results').classList.contains('hidden'), true);
});

test('broken and unavailable storage do not prevent initialization', async () => {
    for (const options of [{corrupt: true}, {blocked: true}]) {
        const e = await environment(options);
        assert.equal(e.get('player-title').textContent, 'Episode 1');
        await e.video.fire('timeupdate');
        for (const fn of [...e.timers.values()]) fn();
        const main = await environment({...options, main: true});
        assert.equal(main.get('series-section').classList.contains('hidden'), false);
    }
});

test('direct playback restores progress and encodes special characters', async () => {
    const e = await environment();
    assert.match(e.video.src, /Test%20%231\.mp4/);
    await e.video.fire('loadedmetadata');
    assert.equal(e.video.currentTime, 120);
    assert.equal(e.get('time-total').textContent, '16:40');
});

test('auto HLS initializes labels and restores saved position', async () => {
    const e = await environment({autoHLS: true});
    assert.equal(e.get('player-title').textContent, 'Episode 1');
    assert.equal(e.get('time-total').textContent, '16:40');
    const hls = e.calls.find(call => call.hls).hls;
    assert.equal(hls.options.startPosition, 120);
    await e.video.fire('loadedmetadata');
    assert.equal(e.video.currentTime, 120);
});

test('native HLS plays without Hls.js; unavailable auto HLS falls back to normal playback', async () => {
    const native = await environment({autoHLS: true, native: true, missingHLS: true});
    assert.match(native.video.src, /playlist\.m3u8$/);
    await native.video.fire('loadedmetadata');
    assert.equal(native.video.currentTime, 120);
    const missing = await environment({autoHLS: true, missingHLS: true});
    assert.match(missing.video.src, /\/stream\//);
    await missing.video.fire('loadedmetadata');
    assert.equal(missing.video.currentTime, 120);
});

test('local converted media uses prepared HLS and keeps saved progress', async () => {
    for (const strategy of ['remux', 'transcode']) {
        const e = await environment({strategy, autoHLS: true});
        const hls = e.calls.find(call => call.hls).hls;
        assert.equal(hls.options.startPosition, 120);
        assert.match(e.get('playback-mode').textContent, /Prepared playback/);
        await e.video.fire('loadedmetadata');
        assert.equal(e.video.currentTime, 120);
    }
});

test('live playback labels compatibility quality and retains fractional seek positions', async () => {
    const e = await environment({strategy: 'transcode'});
    assert.match(e.get('playback-mode').textContent, /1080p/);
    await e.get('progress-bar').fire('click', {clientX: 12.345});
    assert.equal(Number(new URL(e.video.src, 'http://localhost').searchParams.get('start')), 123.45);
    await e.video.fire('timeupdate');
    for (const fn of [...e.timers.values()]) fn();
    assert.equal(JSON.parse(e.stored.get('sanflix_progress'))[e.item.id].time, 123.45);
});

test('failed direct playback converts and keeps conversion on every seek', async () => {
    const e = await environment();
    e.video.error = {code: 4};
    await e.video.fire('error');
    assert.match(e.video.src, /force_transcode=1/);
    await e.get('progress-bar').fire('click', {clientX: 50});
    assert.match(e.video.src, /start=500/);
    assert.match(e.video.src, /force_transcode=1/);
    await e.get('btn-forward').fire('click');
    assert.match(e.video.src, /force_transcode=1/);
    await e.get('btn-rewind').fire('click');
    assert.match(e.video.src, /force_transcode=1/);
    assert.equal(e.video.listeners.error.length, 1);
});

test('completed playback is not resurrected by a pending progress timer', async () => {
    const e = await environment();
    await e.video.fire('timeupdate');
    e.video.ended = true;
    await e.video.fire('ended');
    for (const fn of [...e.timers.values()]) fn();
    assert.equal(JSON.parse(e.stored.get('sanflix_progress'))[e.item.id], undefined);
});

test('starting HLS sends a protected POST', async () => {
    const e = await environment();
    await e.context.startHLS();
    const request = e.calls.find(call => call.url?.includes('/api/hls/start/'));
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['X-CSRF-Token'], 'test-csrf');
});

test('reopening HLS resets a stale playback action and completed appearance', async () => {
    const e = await environment();
    let stalePlayback = false;
    e.get('btn-hls-start').onclick = () => { stalePlayback = true; };
    e.get('hls-progress-fill').classList.add('done');
    e.get('hls-panel-title').textContent = 'Ready to Stream!';
    e.context.openHLSPanel();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(e.get('hls-progress-fill').classList.contains('done'), false);
    assert.equal(e.get('hls-panel-title').textContent, 'Prepared playback');
    await e.get('btn-hls-start').onclick();
    assert.equal(stalePlayback, false);
    assert.ok(e.calls.some(call => call.url?.includes('/api/hls/start/')));
});

test('keyboard seek clamps position and exposes an accessible progress value', async () => {
    const e = await environment();
    await e.video.fire('loadedmetadata');
    await e.get('progress-bar').fire('keydown', {key: 'ArrowRight'});
    assert.equal(e.video.currentTime, 130);
    await e.video.fire('timeupdate');
    assert.equal(e.get('progress-bar').attributes['aria-valuenow'], '130');
    await e.get('progress-bar').fire('keydown', {key: 'Home'});
    assert.equal(e.video.currentTime, 0);
    await e.get('progress-bar').fire('keydown', {key: 'End'});
    assert.equal(e.video.currentTime, 999.9);
});

test('double tap seeks without changing play/pause state', async () => {
    const e = await environment();
    await e.video.fire('loadedmetadata');
    const paused = e.video.paused;
    await e.get('player-wrapper').fire('click', {clientX: 90});
    await e.get('player-wrapper').fire('click', {clientX: 90});
    assert.equal(e.video.currentTime, 130);
    assert.equal(e.video.paused, paused);
});

test('next episode transition can be cancelled', async () => {
    const e = await environment({nextEpisode: true});
    await e.video.fire('ended');
    assert.equal(e.get('up-next-title').textContent, 'Episode 2');
    e.get('up-next-cancel').onclick();
    for (const fn of [...e.timers.values()]) fn();
    assert.equal(e.context.location.href, '');
    assert.equal(e.get('up-next').classList.contains('hidden'), true);
});
