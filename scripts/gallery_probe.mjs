/**
 * gallery_probe.mjs
 *
 * 通过 Chrome DevTools Protocol 连接一个已开启 --remote-debugging-port 的
 * Edge/Chrome 实例，从**电商/图库类页面**（淘宝、天猫、1688 等）提取
 * 商品主图与视频的直链。
 *
 * 为什么不能只读 DOM：
 *   - 商品缩略图区多为 CSS background-image，读 innerText / DOM 快照拿不到；
 *   - 真实主图列表常内嵌在页面 HTML 的 <script> JSON 里（"images" / "videos" 数组），
 *     数组顺序才是主图顺序。
 * 所以本脚本三路并取：内嵌 JSON + CSS 背景图 + <img> 元素。
 *
 * 用法:
 *   node gallery_probe.mjs --port 9222 --url "<商品页URL>" --out probe.json
 *        [--wait 8000] [--ua "<UA>"] [--noDom]
 *
 * 输出:
 *   <out>          JSON：candidates / json.images / json.videos / backgroundImages / imgTags ...
 *   <out>.html     页面 outerHTML（供人工复查，可 --noDom 跳过）
 *
 * 复用的是 SKILL.md 步骤 3.1 那个无头 Edge 实例，不需要另起第二个。
 */

import fs from 'node:fs';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0';

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    a[k] = v === undefined ? true : v;
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

function call(ws, id, method, params = {}, timeoutMs = 60000) {
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

/** DOM 层提取：CSS 背景图 + <img>（页面内执行） */
const EXTRACT_EXPR = `(() => {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return u; } };
  const out = { title: document.title, url: location.href, backgroundImages: [], imgTags: [] };
  try {
    const seen = new Set();
    for (const el of document.querySelectorAll('*')) {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') {
        const parts = bg.match(/url\\(["']?[^"')]+["']?\\)/g) || [];
        for (const one of parts) {
          const u = one.replace(/^url\\(["']?/, '').replace(/["']?\\)$/, '');
          const a = abs(u);
          if (a && !a.startsWith('data:') && !seen.has(a)) { seen.add(a); out.backgroundImages.push(a); }
        }
      }
    }
  } catch (e) { out.bgErr = String(e); }
  try {
    out.imgTags = [...document.querySelectorAll('img')].map((i) => ({
      src: abs(i.currentSrc || i.src || i.getAttribute('data-src') || ''),
      w: i.naturalWidth, h: i.naturalHeight
    })).filter((x) => x.src && !x.src.startsWith('data:'));
  } catch (e) { out.imgErr = String(e); }
  return JSON.stringify(out);
})()`;

/** 从 HTML 里抠内嵌 JSON 数组（逐 key，保序去重） */
export function grabJsonArrays(html, keys) {
  const out = {};
  for (const key of keys) {
    const set = new Set();
    const re = new RegExp('"' + key + '"\\s*:\\s*\\[([^\\]]*)\\]', 'g');
    let m;
    while ((m = re.exec(html))) {
      const urls = m[1].match(/https?:[^"'\s\\]+|\/\/[^"'\s\\]+/g) || [];
      for (const u of urls) set.add(u);
    }
    out[key] = [...set];
  }
  return out;
}

/** 从 HTML 里抠 <img> 与 background-image（DOM 取不到时的兜底） */
export function grabFromHtml(html) {
  const imgs = new Set();
  const bg = new Set();
  let m;
  const imgRe = /<img[^>]*>/gi;
  while ((m = imgRe.exec(html))) {
    for (const attr of ['src', 'data-src', 'data-ks-lazyload', 'data-original', 'data-img']) {
      const a = m[0].match(new RegExp(attr + '\\s*=\\s*["\']([^"\']+)["\']', 'i'));
      if (a) imgs.add(a[1]);
    }
  }
  const bgRe = /background(?:-image)?\s*:\s*url\(["']?([^"')]+)["']?\)/gi;
  while ((m = bgRe.exec(html))) bg.add(m[1]);
  return { imgs: [...imgs], bg: [...bg] };
}

export function guessKind(u) {
  if (/\.(mp4|mov|m3u8|flv)(\?|$)/i.test(u)) return 'video';
  if (/\.gif(\?|$)/i.test(u)) return 'gif';
  if (/\.(jpe?g|png|webp|avif)(\?|$|_)/i.test(u)) return 'image';
  return 'other';
}

async function main() {
  const args = parseArgs(process.argv);
  const port = args.port || '9222';
  const wait = parseInt(args.wait || '8000', 10);
  const ua = args.ua || DEFAULT_UA;
  const out = args.out || 'gallery.json';
  const url = args.url;
  if (!url || url === true) throw new Error('--url is required');
  const base = `http://127.0.0.1:${port}`;

  const list = await (await fetch(base + '/json/list')).json();
  const page = list.find((t) => t.type === 'page') || list[0];
  if (!page) throw new Error('no page target found');

  const ws = await connect(page.webSocketDebuggerUrl);
  let id = 1;
  await call(ws, id++, 'Page.enable');
  await call(ws, id++, 'Runtime.enable');
  await call(ws, id++, 'Emulation.setUserAgentOverride', { userAgent: ua, platform: 'Win32' });
  await call(ws, id++, 'Page.navigate', { url });
  await sleep(wait);

  const res = {
    title: '', url, backgroundImages: [], imgTags: [], json: {}, candidates: [], htmlFile: null
  };

  const domR = await call(ws, id++, 'Runtime.evaluate', { expression: EXTRACT_EXPR, returnByValue: true });
  const dom = JSON.parse((domR.result && domR.result.value) || '{}');
  res.title = dom.title || '';
  res.backgroundImages = dom.backgroundImages || [];
  res.imgTags = dom.imgTags || [];

  if (!args.noDom) {
    try {
      const htmlR = await call(ws, id++, 'Runtime.evaluate', {
        expression: 'document.documentElement.outerHTML', returnByValue: true
      }, 90000);
      const html = (htmlR.result && htmlR.result.value) || '';
      res.htmlFile = out.replace(/\.json$/, '') + '.html';
      fs.writeFileSync(res.htmlFile, html, 'utf8');
      res.htmlChars = html.length;
      res.json = grabJsonArrays(html, ['images', 'mainImages', 'imageList', 'videos', 'videoList']);
      const extra = grabFromHtml(html);
      res.htmlImgs = extra.imgs;
      res.htmlBackgrounds = extra.bg;
    } catch (e) { res.htmlErr = String(e); }
  }

  // 合并去重保序：内嵌 JSON 优先，其次 DOM
  const ordered = [];
  const seen = new Set();
  const push = (u) => {
    if (!u || typeof u !== 'string') return;
    let x = u.trim();
    if (x.startsWith('//')) x = 'https:' + x;
    if (!x || x.startsWith('data:')) return;
    if (!seen.has(x)) { seen.add(x); ordered.push(x); }
  };
  for (const k of ['images', 'mainImages', 'imageList']) (res.json[k] || []).forEach(push);
  for (const k of ['videos', 'videoList']) (res.json[k] || []).forEach(push);
  (res.backgroundImages || []).forEach(push);
  (res.imgTags || []).forEach((t) => push(t.src));
  (res.htmlImgs || []).forEach(push);
  (res.htmlBackgrounds || []).forEach(push);
  res.candidates = ordered.map((u) => ({ url: u, kind: guessKind(u) }));

  fs.writeFileSync(out, JSON.stringify(res, null, 2), 'utf8');
  console.log('TITLE=' + res.title);
  console.log('JSON_IMAGES=' + (res.json.images || []).length);
  console.log('JSON_VIDEOS=' + (res.json.videos || []).length);
  console.log('CANDIDATES=' + res.candidates.length);
  for (const c of res.candidates.slice(0, 40)) console.log(c.kind + '\t' + c.url);
  console.log('WROTE=' + out + (res.htmlFile ? ' HTML=' + res.htmlFile : ''));
  ws.close();
}

// 直接运行时才执行 main，便于被其它脚本 import 复用上面的解析函数
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/gallery_probe.mjs')) {
  main().catch((e) => {
    console.error('ERR ' + e.message);
    process.exit(1);
  });
}
