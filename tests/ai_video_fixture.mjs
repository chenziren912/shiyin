// Local HTTP contract fixture; it never contacts a real provider.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..'), directory = path.join(root, '.test-output', 'AI接口模拟', String(Date.now()));
await fs.mkdir(directory, { recursive: true });
const media = await fs.readFile(path.join(root, ".test-output/中文路径 ' [测试]/短背景.mp4"));
let scenario = 'async', jobs = new Map(), creates = 0, polls = 0, active = 0, peak = 0, optimized = 0, downloads = 0, cdnAuth = false, lastBody, formOk = false, requestAuth = true;
const send = (res, status, value, headers = {}) => { const bytes = Buffer.from(JSON.stringify(value)); res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length, ...headers }); res.end(bytes); };
const cdn = http.createServer((req, res) => { cdnAuth ||= !!req.headers.authorization || !!req.headers['x-fixture']; res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': media.length }); res.end(media); });
await new Promise(resolve => cdn.listen(0, '127.0.0.1', resolve));
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2000000) throw new Error('oversized'); }
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/__test/status') return send(res, 200, { scenario, creates, polls, active, peak, optimized, downloads, cdnAuth, lastBody, formOk, requestAuth, jobs: [...jobs.keys()] });
    if (url.pathname === '/__test/control') { const value = JSON.parse(raw || '{}'); if (value.reset) { jobs = new Map(); creates = polls = active = peak = optimized = downloads = 0; cdnAuth = false; formOk = false; lastBody = null; requestAuth = true; } if (value.scenario) scenario = value.scenario; return send(res, 200, { ok: true }); }
    requestAuth &&= req.headers.authorization === 'Bearer fixture-key';
    if (url.pathname === '/v1/models') return send(res, 200, { data: [{ id: 'fixture-video' }, { id: 'fixture-text' }] });
    if (url.pathname === '/v1/chat/completions') {
      optimized++; if (scenario === 'optim-fail') return send(res, 503, { error: 'fixture optimizer unavailable' });
      return send(res, 200, { choices: [{ message: { content: 'A quiet moonlit alpine lake with soft mist drifting across distant forest silhouettes. One continuous locked-off shot, restrained blue-green tones and natural water ripples. Preserve broad uncluttered negative space for the overlay layout. No text or logos; stable exposure and a loop-friendly composition.' } }] });
    }
    if (req.method === 'POST' && ['/v1/videos','/v1/custom'].includes(url.pathname)) {
      creates++;
      if (scenario === 'drop-post') return req.socket.destroy();
      const json = req.headers['content-type']?.includes('application/json');
      if (json) lastBody = JSON.parse(raw); else { formOk = ['model','prompt','seconds','size'].every(name => new RegExp(`name=(?:"${name}"|${name})[;\\r\\n]`).test(raw)); lastBody = { multipart: true, includesReservedSpace: raw.includes('negative space'), includesWords: raw.includes('Moonlight') }; }
      if (scenario === 'instant') return send(res, 200, { url: `http://127.0.0.1:${cdn.address().port}/video.mp4` });
      const id = 'job_' + creates; jobs.set(id, { polls: 0, released: false }); active++; peak = Math.max(peak, active);
      return send(res, 200, scenario === 'nested' ? { data: { task: { id, state: 'queued' } } } : { id, status: 'queued', progress: 0 });
    }
    const match = url.pathname.match(/^\/v1\/(?:videos|custom)\/(job_\d+)(\/content)?$/);
    if (match) {
      const job = jobs.get(match[1]); if (!job) return send(res, 404, { error: 'not found' });
      if (match[2]) {
        downloads++; if (!job.released) { active--; job.released = true; }
        if (scenario === 'invalid-media') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end('not a video file '.repeat(100)); }
        if (scenario === 'too-large') { res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '2147483648' }); return res.end(); }
        res.writeHead(302, { location: `http://127.0.0.1:${cdn.address().port}/video.mp4` }); return res.end();
      }
      job.polls++; polls++;
      if (scenario === 'throttle' && job.polls === 1) return send(res, 429, { error: 'rate limit' }, { 'retry-after': '1' });
      if (scenario === 'failed') return send(res, 200, { id: match[1], status: 'failed', error: { message: 'fixture-key should not be echoed' } });
      const completed = job.polls >= 2 && scenario !== 'pending';
      const value = scenario === 'nested' ? { data: { task: { id: match[1], state: completed ? 'done' : 'working', percent: completed ? 100 : 35 }, result: completed ? { files: [{ url: `http://127.0.0.1:${server.address().port}/v1/custom/${match[1]}/content` }] } : {} } } : { id: match[1], status: completed ? 'completed' : 'in_progress', progress: completed ? 100 : 35 };
      return send(res, 200, value);
    }
    send(res, 404, { error: 'not found' });
  } catch { if (!res.headersSent) send(res, 500, { error: 'fixture failure' }); else res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const config = { baseUrl: `http://127.0.0.1:${server.address().port}/v1/`, control: `http://127.0.0.1:${server.address().port}/__test/control`, status: `http://127.0.0.1:${server.address().port}/__test/status`, directory };
await fs.writeFile(path.join(directory, 'fixture.json'), JSON.stringify(config, null, 2));
await fs.writeFile(path.join(root, '.test-output', 'ai-fixture-current.json'), JSON.stringify(config, null, 2));
console.log(path.join(directory, 'fixture.json'));
async function close() { server.close(); cdn.close(); }
process.on('SIGINT', close); process.on('SIGTERM', close);
