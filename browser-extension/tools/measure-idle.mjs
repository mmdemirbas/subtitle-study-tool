/* What the extension costs while nobody is using it: whether the service
 * worker is started by things the reader does anyway, and what each start
 * costs the extension's process.
 *
 *   node tools/measure-idle.mjs <label> [--daemon-port N] [--youtube]
 *
 * Copies manifest.json, src/ and icons/ from this checkout into
 * tmp/measure-idle/ext-<label>/, points DAEMON_ORIGIN at --daemon-port (by
 * default port 1, where nothing listens), loads that copy into headless Brave
 * on a throwaway profile, and then: 90s of start, a wait for the worker to
 * stop by itself, a visit to each of four pages (three public, one served here
 * with two frames) with a wait for the worker to stop after each, and with
 * --youtube a YouTube film played for 90s and its tab closed. One JSON line per
 * run goes to tmp/measure-idle/results.jsonl. For a before/after, run it from a
 * worktree at each commit.
 *
 * Never point --daemon-port at the daemon you use: the copy converges with it
 * (pulling every cached subtitle into the throwaway profile) and writes its
 * running log there. Run a second daemon from a copy of subtitle-daemon/ on a
 * spare port instead; its cache and logs land beside the copy.
 *
 * Brave is started directly rather than through Playwright: Playwright
 * attaches to every service worker, and an attached worker is never stopped,
 * so whether an event starts a stopped one could not be seen. Only the page is
 * attached here; workers are counted from target discovery, which holds
 * nothing. Nothing in the real browser profile is read, loaded or written.
 *
 * Measured 2026-11-07 (Brave 1.98.60, M1 Max, load ~39, a scratch daemon
 * holding a copy of the 481 cached subtitles), before 0c39e90 and after
 * eaa6b9d: the worker was started by each of example.com, Wikipedia,
 * example.org and the two-frame page (0.05-0.06s of CPU, a 75MB process) and
 * by closing a tab (0.07s); after, by none of them, with no extension process
 * left. The first 90s spent 3.52s of CPU, then 1.18s once b9db9b7 decoded the
 * pulled subtitles natively. */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const args = process.argv.slice(2);
const label = args[0];
const portAt = args.indexOf('--daemon-port');
const daemonPort = portAt >= 0 ? Number(args[portAt + 1]) : 1;
if (!label || label.startsWith('--') || !Number.isInteger(daemonPort) || daemonPort < 1) {
	console.error('usage: node tools/measure-idle.mjs <label> [--daemon-port N] [--youtube]');
	process.exit(64);
}
const youtube = args.includes('--youtube');
const EXTENSION = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = path.resolve(EXTENSION, '..', 'tmp', 'measure-idle');
const ext = path.join(WORK, `ext-${label}`);
fs.rmSync(ext, { recursive: true, force: true });
for (const part of ['manifest.json', 'src', 'icons']) fs.cpSync(path.join(EXTENSION, part), path.join(ext, part), { recursive: true });
for (const file of ['src/daemon.js', 'manifest.json']) {
	const at = path.join(ext, file);
	const text = fs.readFileSync(at, 'utf8');
	if (!text.includes('127.0.0.1:8794')) throw new Error(`no daemon origin to repoint in ${file}`);
	fs.writeFileSync(at, text.replaceAll('127.0.0.1:8794', `127.0.0.1:${daemonPort}`));
}
// A page with two plain frames, on the loopback only.
const pages = http.createServer((req, res) => {
	res.setHeader('content-type', 'text/html');
	res.end(req.url.startsWith('/child') ? '<!doctype html><title>child</title><p>child frame</p>' : '<!doctype html><title>with frames</title><p>Two frames.</p><iframe src="/child?a"></iframe><iframe src="/child?b"></iframe>');
});
await new Promise((done) => pages.listen(0, '127.0.0.1', done));
const FRAMES = `http://127.0.0.1:${pages.address().port}/frames`;
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const REAL = path.join(os.homedir(), 'Library/Application Support/BraveSoftware');
fs.mkdirSync(WORK, { recursive: true });
const profile = fs.mkdtempSync(path.join(WORK, 'profile-'));
for (const p of [ext, profile]) if (p.startsWith(REAL)) throw new Error(`refusing a path in the real profile: ${p}`);
if (!fs.existsSync(path.join(ext, 'manifest.json'))) throw new Error(`no manifest in ${ext}`);
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const exec = promisify(execFile);
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${label}`, ...a);

// The owner's settings: Energy Saver and Memory Saver on, as in the real Local State.
// Downloads stay inside the throwaway profile: the extension's log falls back to a download when no daemon answers.
fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
fs.writeFileSync(path.join(profile, 'Default/Preferences'), JSON.stringify({ download: { default_directory: path.join(profile, 'downloads'), prompt_for_download: false } }));
fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ performance_tuning: { battery_saver_mode: { state: 2 }, high_efficiency_mode: { state: 2, aggressiveness: 2 } } }));
const brave = spawn(BRAVE, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', `--load-extension=${ext}`, `--disable-extensions-except=${ext}`,
	'--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });

let port;
for (let i = 0; i < 100 && !port; i++) {
	await sleep(200);
	try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {}
}
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
let nextId = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = ({ data }) => {
	const m = JSON.parse(data);
	if (m.id !== undefined) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.fail(new Error(`${p.method}: ${m.error.message}`)) : p.done(m.result); }
	else for (const fn of listeners) fn(m);
};
const send = (method, params = {}, sessionId) => new Promise((done, fail) => {
	const id = ++nextId;
	pending.set(id, { done, fail, method });
	ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

// The worker, by target events.
const sw = { alive: 0, starts: 0, stops: 0, ids: new Set() };
listeners.push((m) => {
	const info = m.params?.targetInfo;
	if (m.method === 'Target.targetCreated' && info.type === 'service_worker' && info.url.endsWith('/src/background.js')) { sw.ids.add(info.targetId); sw.alive += 1; sw.starts += 1; }
	if (m.method === 'Target.targetDestroyed' && sw.ids.has(m.params.targetId)) { sw.ids.delete(m.params.targetId); sw.alive -= 1; sw.stops += 1; }
});
await send('Target.setDiscoverTargets', { discover: true });

// The process tree, by the profile path; a process that ended keeps its last reading.
const kindOf = (c) => c.includes('--type=renderer') ? (c.includes('--extension-process') ? 'ext' : 'page') : c.includes('--type=gpu-process') ? 'gpu' : c.includes('--type=utility') ? 'utility' : c.includes('--type=') ? 'other' : 'browser';
const seen = new Map();
async function readTree() {
	const { stdout } = await exec('/bin/ps', ['-axww', '-o', 'pid=,ppid=,rss=,time=,command='], { maxBuffer: 1 << 27 });
	const all = stdout.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean)
		.map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3], cpu: m[4].split(':').reduce((s, x) => s * 60 + Number(x), 0), command: m[5] }));
	const inside = new Set([brave.pid]);
	for (let grew = true; grew;) { grew = false; for (const p of all) if (!inside.has(p.pid) && inside.has(p.ppid)) { inside.add(p.pid); grew = true; } }
	for (const one of seen.values()) one.alive = false;
	for (const p of all) if (inside.has(p.pid)) seen.set(p.pid, { kind: kindOf(p.command), cpu: p.cpu, rss: p.rss, alive: true });
	return new Map([...seen].map(([pid, one]) => [pid, one.cpu]));
}
const ticker = setInterval(() => void readTree().catch(() => {}), 1000);
function spent(from, to) {
	const by = { total: 0 };
	for (const [pid, cpu] of to) { const d = cpu - (from.get(pid) ?? 0); const { kind } = seen.get(pid); by[kind] = (by[kind] ?? 0) + d; by.total += d; }
	for (const k of Object.keys(by)) by[k] = Math.round(by[k] * 100) / 100;
	return by;
}
const rss = () => { const by = {}; for (const one of seen.values()) if (one.alive) by[one.kind] = (by[one.kind] ?? 0) + Math.round(one.rss / 1024); return by; };

const result = { label, ext, at: new Date().toISOString(), load1: os.loadavg()[0], phases: [] };
async function phase(name, run) {
	const before = await readTree();
	const starts = sw.starts;
	const began = Date.now();
	const extra = (await run()) ?? {};
	const after = await readTree();
	const one = { name, seconds: Math.round((Date.now() - began) / 1000), cpu: spent(before, after), swStarts: sw.starts - starts, swAliveAtEnd: sw.alive, rss: rss(), ...extra };
	result.phases.push(one);
	log(name.padEnd(28), `ext ${one.cpu.ext ?? 0}s page ${one.cpu.page ?? 0}s total ${one.cpu.total}s`, `sw starts ${one.swStarts} alive ${one.swAliveAtEnd}`, `rss ext ${one.rss.ext ?? 0}MB`, extra.note ?? '');
}
async function untilWorkerStops(limitMs) {
	const end = Date.now() + limitMs;
	while (sw.alive > 0 && Date.now() < end) await sleep(1000);
	return { stopped: sw.alive === 0 };
}

let page;
try {
	await phase('start, 90 s', () => sleep(90000));
	await phase('worker stops by itself', async () => untilWorkerStops(180000));

	const { targetInfos } = await send('Target.getTargets');
	const target = targetInfos.find((t) => t.type === 'page');
	page = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
	const ua = (await send('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome');
	await send('Emulation.setUserAgentOverride', { userAgent: ua }, page);
	await send('Page.enable', {}, page);
	await send('Runtime.enable', {}, page);
	for (const url of ['https://example.com/', 'https://en.wikipedia.org/wiki/Subtitles', FRAMES, 'https://example.org/']) {
		await phase(`visit ${url === FRAMES ? 'a page with two frames' : new URL(url).host}, 20 s`, async () => { await send('Page.navigate', { url }, page); await sleep(20000); });
		await phase('  then until the worker stops', async () => untilWorkerStops(120000));
	}

	if (youtube) {
		const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page)).result.value;
		await phase('youtube, load and play, 30 s', async () => {
			await send('Page.navigate', { url: VIDEO }, page);
			await sleep(6000);
			await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /Reject all|Tümünü reddet/.test(x.textContent)); if (b) b.click(); return !!b; })()`);
			for (let i = 0; i < 20; i++) {
				const playing = await evaluate(`(() => { const v = document.querySelector('#movie_player video'); if (!v) return false; if (v.paused) v.play().catch(() => {}); return v.currentTime > 0.1 && !v.paused; })()`);
				if (playing) break;
				await sleep(1000);
			}
			await sleep(Math.max(0, 30000 - 6000));
			const state = await evaluate(`(() => { const v = document.querySelector('#movie_player video'); return JSON.stringify({ title: document.title.slice(0, 60), video: !!v, paused: v?.paused, t: v?.currentTime, ad: !!document.querySelector('.ad-showing'), error: document.querySelector('.ytp-error')?.textContent?.slice(0, 80) ?? null }); })()`);
			return { state, note: state };
		});
		await send('Performance.enable', { timeDomain: 'threadTicks' }, page);
		await send('Profiler.enable', {}, page);
		await send('Profiler.setSamplingInterval', { interval: 1000 }, page);
		const metrics = async () => Object.fromEntries((await send('Performance.getMetrics', {}, page)).metrics.map((m) => [m.name, m.value]));
		await phase('youtube playing, 60 s', async () => {
			const m0 = await metrics();
			await send('Profiler.start', {}, page);
			await sleep(60000);
			const { profile } = await send('Profiler.stop', {}, page);
			const m1 = await metrics();
			const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
			const parent = new Map();
			for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
			const own = new Map();
			let extMs = 0;
			profile.samples.forEach((id, i) => {
				const ms = (profile.timeDeltas[i] ?? 0) / 1000;
				let at = id;
				while (at !== undefined && !nodes.get(at).callFrame.url) at = parent.get(at);
				const url = at === undefined ? '' : nodes.get(at).callFrame.url;
				if (!url.startsWith('chrome-extension://')) return;
				extMs += ms;
				const f = nodes.get(id).callFrame;
				const key = `${f.functionName || '(anon)'} ${f.url.split('/').slice(3).join('/')}:${f.lineNumber + 1}`;
				own.set(key, (own.get(key) ?? 0) + ms);
			});
			const playing = await evaluate(`(() => { const v = document.querySelector('#movie_player video'); return !!v && !v.paused && v.currentTime; })()`);
			return {
				taskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000), scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000),
				extJsMs: Math.round(extMs), extTop: [...own].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, Math.round(v)]),
				playing, note: `task ${Math.round((m1.TaskDuration - m0.TaskDuration) * 1000)}ms ext js ${Math.round(extMs)}ms playing ${playing}`
			};
		});
		await phase('  then until the worker stops', async () => untilWorkerStops(120000));
		await phase('close the youtube tab, 20 s', async () => {
			await send('Target.createTarget', { url: 'about:blank' });
			await send('Target.closeTarget', { targetId: target.targetId });
			await sleep(20000);
		});
	}
} catch (e) {
	result.error = String(e.message);
	log('ERROR', e.message);
} finally {
	clearInterval(ticker);
	try { await send('Browser.close'); } catch {}
	await sleep(3000);
	try { process.kill(brave.pid, 'SIGKILL'); } catch {}
	fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
	pages.close();
	fs.appendFileSync(path.join(WORK, 'results.jsonl'), JSON.stringify(result) + '\n');
	process.exit(0);
}
