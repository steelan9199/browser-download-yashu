/**
 * cdp_media_probe.mjs
 *
 * 通过 Chrome DevTools Protocol 连接一个已开启 --remote-debugging-port 的
 * Edge/Chrome 实例，用于：
 *   1. mode=media  （默认）加载目标页面，提取页面内的媒体直链（抖音 DASH 流）
 *   2. mode=cookies       导出该实例的 cookie（Netscape 格式，可直接喂给 yt-dlp）
 *
 * 用法:
 *   node cdp_media_probe.mjs --port 9222 --url "<videoUrl>" [--mode media|cookies]
 *                            [--out probe.json] [--wait 15000] [--ua "<UA>"]
 *
 * 重要经验（踩过的坑）:
 *   - 浏览器级 WebSocket 上 Network.getAllCookies 报 "wasn't found"，
 *     必须连 /json/list 里的 page target。
 *   - 不设置 UA 的话 headless 会被识别，抖音返回验证码中间页。
 *   - Netscape cookie 文件里 domain 以 "." 开头时第 2 列必须是 TRUE，
 *     且必须过滤掉 name 为空的条目，否则 yt-dlp 直接报格式错误。
 */

import fs from 'node:fs';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0';

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    a[k] = argv[i + 1];
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('websocket connect failed'));
  });
}

function call(ws, id, method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: ' + method)), timeoutMs);
    const handler = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === id) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        if (m.error) reject(new Error(method + ' -> ' + JSON.stringify(m.error)));
        else resolve(m.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** 页面内执行的提取逻辑：视频元素 + 资源请求 + 路由数据里的直链 */
const EXTRACT_EXPR = `(() => {
  const out = { title: document.title, url: location.href, videos: [], perf: [], playAddr: [] };
  try {
    out.videos = [...document.querySelectorAll('video')].map(v => ({
      src: v.src, duration: v.duration, width: v.videoWidth, height: v.videoHeight
    }));
  } catch (e) { out.videoErr = String(e); }
  try {
    out.perf = performance.getEntriesByType('resource')
      .map(r => r.name)
      .filter(n => /media-video|media-audio|douyinvod|\\.mp4|m3u8|tos-cn-vd|tos-cn-ve/.test(n));
  } catch (e) { out.perfErr = String(e); }
  try {
    const s = JSON.stringify(window._ROUTER_DATA || {});
    const m = s.match(/https:[^"]*?(douyinvod|media-video|media-audio)[^"]*/g);
    if (m) out.playAddr = [...new Set(m)];
  } catch (e) { out.routerErr = String(e); }
  return JSON.stringify(out);
})()`;

async function main() {
  const args = parseArgs(process.argv);
  const port = args.port || '9222';
  const mode = args.mode || 'media';
  const wait = parseInt(args.wait || '15000', 10);
  const ua = args.ua || DEFAULT_UA;
  const out = args.out || 'probe.json';
  const url = args.url;
  const base = `http://127.0.0.1:${port}`;

  const list = await (await fetch(base + '/json/list')).json();
  const page = list.find((t) => t.type === 'page') || list[0];
  if (!page) throw new Error('no page target found');

  const ws = await connect(page.webSocketDebuggerUrl);
  let id = 1;
  await call(ws, id++, 'Page.enable');
  await call(ws, id++, 'Runtime.enable');
  await call(ws, id++, 'Network.enable');

  const result = { mode, browser: null, cookies: [], media: null };

  if (mode === 'cookies') {
    const r = await call(ws, id++, 'Network.getAllCookies');
    result.cookies = (r.cookies || []).filter((c) => c.name);
    const lines = ['# Netscape HTTP Cookie File', '# exported via CDP'];
    for (const c of result.cookies) {
      const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const exp = Math.floor(
        c.expires && c.expires > 0 ? c.expires : Date.now() / 1000 + 31536000
      );
      // 注意：domain 以点开头时必须对应 TRUE，否则 yt-dlp/http.cookiejar 会判定格式非法
      lines.push(
        [c.domain, includeSub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t')
      );
    }
    const cookieFile = args.cookieFile || out.replace(/\.json$/, '') + '.cookies.txt';
    fs.writeFileSync(cookieFile, lines.join('\n') + '\n', 'ascii');
    result.cookieFile = cookieFile;
    console.log('COOKIES=' + result.cookies.length + ' -> ' + cookieFile);
  } else {
    if (!url) throw new Error('--url is required in media mode');
    // 伪装成真实浏览器，否则抖音返回验证码页
    await call(ws, id++, 'Emulation.setUserAgentOverride', { userAgent: ua, platform: 'Win32' });
    await call(ws, id++, 'Page.navigate', { url });
    await sleep(wait);
    const r = await call(ws, id++, 'Runtime.evaluate', {
      expression: EXTRACT_EXPR,
      returnByValue: true,
    });
    const raw = (r.result && r.result.value) || '{}';
    result.media = JSON.parse(raw);
    const video = (result.media.perf || []).filter((u) => /media-video/.test(u));
    const audio = (result.media.perf || []).filter((u) => /media-audio/.test(u));
    console.log('TITLE=' + result.media.title);
    console.log('VIDEO_STREAMS=' + video.length);
    console.log('AUDIO_STREAMS=' + audio.length);
    console.log('VIDEO_URL=' + (video[0] || ''));
    console.log('AUDIO_URL=' + (audio[0] || ''));
  }

  fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
  console.log('WROTE=' + out);
  ws.close();
}

main().catch((e) => {
  console.error('ERR ' + e.message);
  process.exit(1);
});
