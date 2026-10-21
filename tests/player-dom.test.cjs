/* Real player markup and selector integration; decoding is covered by FFmpeg tests. */
process.env.SANFLIX_DEV = process.env.SANFLIX_DEV || "1"; // Templates are rendered by importing the app.
const PYTHON = require("./python-bin.cjs");
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {JSDOM} = require('jsdom');
const root = path.resolve(__dirname, '..');
const html = execFileSync(PYTHON, ['-c',
    "from app import app; from flask import render_template\nwith app.test_request_context('/'):\n print(render_template('player.html', media_id='123456abcdef'))"],
    {cwd: root, encoding: 'utf8', env: {...process.env, PYTHONIOENCODING: 'utf-8'}});
const flush = () => new Promise(resolve => setImmediate(resolve));

test('real player exposes a labelled audio selector and treats track metadata as text', async t => {
    const dom = new JSDOM(html, {url: 'http://localhost/', runScripts: 'outside-only'});
    t.after(() => dom.window.close());
    const w = dom.window, d = w.document, video = d.getElementById('video');
    Object.defineProperty(video, 'paused', {value: false, writable: true});
    Object.defineProperty(video, 'duration', {value: 1000});
    video.pause = () => { video.paused = true; };
    video.play = () => { video.paused = false; return Promise.resolve(); };
    const tracks = [{index: 1, label: 'Tamil'}, {index: 2, label: 'English <img src=x onerror=alert(1)>'}];
    const item = {id: '123456abcdef', title: 'Movie', file: 'media/movie.mkv', category: 'movie', duration_seconds: 1000};
    w.fetch = async url => {
        const query = new URL(url, 'http://localhost').searchParams;
        const data = url === '/api/media' ? [item] : url.startsWith('/api/media/') ? item : {
            strategy: 'remux', audio_tracks: tracks,
            selected_audio_index: Number(query.get('audio') || 1), hls_ready: false
        };
        return {ok: true, json: async () => data};
    };
    for (const script of ['common.js', 'player.js']) w.eval(fs.readFileSync(path.join(root, 'static', script), 'utf8'));
    await flush();
    const select = d.getElementById('audio-track');
    assert.equal(select.labels[0].textContent.trim().startsWith('Audio'), true);
    assert.equal(d.getElementById('audio-control').classList.contains('hidden'), false);
    assert.equal(select.options.length, 2);
    assert.match(select.options[1].textContent, /<img/);
    assert.equal(select.querySelector('img'), null);
    video.currentTime = 222.5;
    select.value = '2';
    select.dispatchEvent(new w.Event('change', {bubbles: true}));
    await flush();
    const stream = new URL(video.src);
    assert.equal(stream.searchParams.get('audio'), '2');
    assert.equal(stream.searchParams.get('start'), '222.5');
    assert.equal(JSON.parse(w.localStorage.getItem('sanflix_audio_tracks'))[item.id], 2);
    const ids = [...d.querySelectorAll('[id]')].map(node => node.id);
    assert.equal(new Set(ids).size, ids.length);
});
