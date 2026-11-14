// Platform status checker.
// Usage:
//   node scripts/check.mjs instabox   - check only the InstaBox machine (API, no browser)
//   node scripts/check.mjs all        - check all 11 platforms, write a complete status.json
//
// Read-only checks only. Never registers, pays, pauses, resumes, stops, creates or
// deletes anything. Secrets come from environment variables and are never printed
// or written into status.json.
//
// Playwright is loaded lazily (dynamic import) only for the three login checks in
// "all" mode, so "instabox" mode runs with plain Node (fetch + net) and no browser.

import fs from 'node:fs';
import net from 'node:net';

const STATUS_FILE = new URL('../status.json', import.meta.url);

const INSTABOX_MACHINE_ID = 'm_agq5ufdgypuf6tjhgd22r3ib2u';
const INSTABOX_MACHINE_NAME = 'muse-free-01';
const GITHUB_USER = 'liuyifei-muse';
const LXI_HOST = 'liuyifei-muse.lxi.be';
const AWS_HOST = 'node.linzheng888.kdns.fr';
const AWS_PORTS = [35079, 26458];

// Platforms that are not checked live; their state only changes when the user acts.
const STATIC = {
  cloady: { status: 'ready', detail: 'workspace workspace-l61c9f (JPN1) · Free plan · $0.00/mo' },
  kaggle: { status: 'pending', detail: 'needs SMS verification' },
  simular: { status: 'ready', detail: 'box main (Asleep) · Box Free · 5000 credits left' },
  colab: { status: 'pending', detail: 'needs Google account' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function defaultStatus() {
  return {
    updated_at: new Date().toISOString(),
    platforms: {
      proton: { status: 'pending', detail: 'not checked yet' },
      github: { status: 'pending', detail: 'not checked yet' },
      lxi: { status: 'pending', detail: 'not checked yet' },
      tinkerhost: { status: 'pending', detail: 'not checked yet' },
      aeonfree: { status: 'pending', detail: 'not checked yet' },
      cloady: { ...STATIC.cloady },
      instabox: {
        status: 'pending',
        detail: 'not checked yet',
        machine: { name: INSTABOX_MACHINE_NAME, id: INSTABOX_MACHINE_ID, state: 'unknown' },
      },
      kaggle: { ...STATIC.kaggle },
      simular: { ...STATIC.simular },
      colab: { ...STATIC.colab },
      aws: { status: 'pending', detail: 'not checked yet' },
    },
  };
}

function readStatus() {
  try {
    const obj = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    if (obj && obj.platforms && typeof obj.platforms === 'object') return obj;
  } catch {
    // Missing or corrupt file: start from a clean default.
  }
  return defaultStatus();
}

function writeStatus(obj) {
  obj.updated_at = new Date().toISOString();
  fs.writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------- InstaBox (API)
// GET /v1/machines/<id> with the API key. Read-only. Retries on transient errors.
async function checkInstabox() {
  const key = process.env.INSTABOX_API_KEY;
  const machine = { name: INSTABOX_MACHINE_NAME, id: INSTABOX_MACHINE_ID, state: 'unknown' };
  if (!key) {
    return { status: 'blocked', detail: 'InstaBox API key 未设置，无法查询机器状态（需在仓库 Secrets 里设置 INSTABOX_API_KEY）', machine };
  }
  const url = `https://api.instabox.sh/v1/machines/${INSTABOX_MACHINE_ID}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'X-API-Key': key },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) {
        return { status: 'blocked', detail: '机器在 InstaBox 上找不到了（HTTP 404，可能已被删除），请检查仪表盘', machine };
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(2000 * attempt);
        continue;
      }
      const data = await res.json();
      const m = Array.isArray(data)
        ? data.find((x) => x && x.id === INSTABOX_MACHINE_ID)
        : data && (data.machine || data);
      if (!m) {
        return { status: 'blocked', detail: '接口返回里没有这台机器（可能已被删除或接口异常），请检查仪表盘', machine };
      }
      const state = String(m.state ?? m.status ?? '').toLowerCase() || 'unknown';
      machine.state = state;
      return {
        status: 'ready',
        detail: `machine ${INSTABOX_MACHINE_NAME} ${cap(state)}`,
        machine,
      };
    } catch (e) {
      lastErr = e;
      await sleep(2000 * attempt);
    }
  }
  return {
    status: 'blocked',
    detail: `InstaBox 接口多次请求失败，无法确认机器状态（${lastErr ? lastErr.message : '未知错误'}，可能是网络问题或接口故障），下次检查会重试`,
    machine,
  };
}

// ---------------------------------------------------------------- GitHub (public API)
async function checkGithub() {
  try {
    const res = await fetch(`https://api.github.com/users/${GITHUB_USER}`, {
      headers: { 'User-Agent': 'platform-status-check', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      if (res.status === 403) return { status: 'blocked', detail: 'GitHub 接口返回 403（可能是限流，稍后恢复；账号本身不受影响）' };
      return { status: 'blocked', detail: `GitHub 接口返回 HTTP ${res.status}（账号本身不受影响）` };
    }
    const data = await res.json();
    if (data && data.login === GITHUB_USER) {
      return { status: 'ready', detail: `user ${GITHUB_USER} exists` };
    }
    return { status: 'blocked', detail: 'GitHub 用户名不符（账号可能有变化，请检查）' };
  } catch (e) {
    return { status: 'blocked', detail: `无法访问 GitHub 接口（${e.message}，网络问题；账号本身不受影响）` };
  }
}

// ---------------------------------------------------------------- LXI (HTTP)
// 200 + a live page = hosting live. 200 + "in preparation" wording = still provisioning.
// The account itself is ready either way; the detail carries the hosting state.
async function checkLxi() {
  try {
    const res = await fetch(`https://${LXI_HOST}`, {
      headers: { 'User-Agent': 'platform-status-check' },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text().catch(() => '');
    const lower = text.toLowerCase();
    const preparing =
      lower.includes('in preparation') ||
      lower.includes('coming soon') ||
      lower.includes('under construction') ||
      lower.includes('preparing');
    if (res.status === 200) {
      if (preparing) return { status: 'ready', detail: 'hosting In preparation (HTTP 200)' };
      return { status: 'ready', detail: 'hosting live (HTTP 200)' };
    }
    return { status: 'blocked', detail: `子域名返回 HTTP ${res.status}（托管可能未开通或网站异常）` };
  } catch (e) {
    return { status: 'blocked', detail: '子域名无法访问：免费托管可能仍在开通中（确认邮箱后最长 24 小时，付费优先），开通后即可访问；账号本身正常' };
  }
}

// ---------------------------------------------------------------- AWS node (TCP)
// No SSH in Actions (no key there). Just confirm the public ports answer.
function tcpCheck(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function checkAws() {
  const results = await Promise.all(
    AWS_PORTS.map(async (port) => ({ port, open: await tcpCheck(AWS_HOST, port, 5000) })),
  );
  const open = results.filter((r) => r.open).map((r) => r.port);
  const closed = results.filter((r) => !r.open).map((r) => r.port);
  if (open.length === AWS_PORTS.length) {
    return { status: 'ready', detail: `ports ${AWS_PORTS.join(', ')} answering` };
  }
  if (open.length > 0) {
    return { status: 'ready', detail: `port ${open.join(', ')} answering, ${closed.join(', ')} closed` };
  }
  return { status: 'blocked', detail: '节点端口无响应（节点可能离线或网络问题，请检查 AWS 控制台）' };
}

// ---------------------------------------------------------------- Playwright logins
// Best-effort selectors (unverified against the live login pages). Any failure is
// recorded as "login check failed" and the run continues with the other platforms.

async function fillFirst(page, selectors, value) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count()) {
      await el.fill(value);
      return true;
    }
  }
  return false;
}

async function clickSubmit(page) {
  const sels = [
    'button[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'button:has-text("Login")',
    'input[type="submit"]',
  ];
  for (const sel of sels) {
    const el = page.locator(sel).first();
    if (await el.count()) {
      await el.click();
      return true;
    }
  }
  return false;
}

// Success = we left the login page, or a log-out control appeared.
// Failure = a login error message appeared, or we are still on the login page.
async function waitForLoginSuccess(page, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    const leftLogin = !/login|sign-?in/i.test(url);
    let hasLogout = false;
    try {
      hasLogout =
        (await page.locator('text=/log ?out|sign ?out/i').first().count()) > 0;
    } catch {}
    if (leftLogin || hasLogout) return true;
    let hasError = false;
    try {
      hasError =
        (await page
          .locator('text=/incorrect|invalid password|wrong password|login failed|authentication failed/i')
          .first()
          .count()) > 0;
    } catch {}
    if (hasError) return false;
    await page.waitForTimeout(2000);
  }
  return false;
}

async function withBrowser(fn) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('playwright not installed');
  }
  const browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

async function loginCheck({ name, url, username, password, userSels, passSels, readyDetail, fallback }) {
  if (!password) return { status: 'blocked', detail: '登录检查缺少密码（仓库 Secrets 未设置对应密码，无法登录检查）' };
  try {
    return await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      let filledUser = await fillFirst(page, userSels, username);
      if (!filledUser && fallback) {
        await fallback(page);
        filledUser = await fillFirst(page, userSels, username);
      }
      if (!filledUser) throw new Error('username field not found');
      let filledPass = await fillFirst(page, passSels, password);
      if (!filledPass) {
        // Possibly a two-step login: advance, then try the password field again.
        await clickSubmit(page);
        await page.waitForTimeout(2000);
        filledPass = await fillFirst(page, passSels, password);
      }
      if (!filledPass) throw new Error('password field not found');
      await clickSubmit(page);
      const ok = await waitForLoginSuccess(page, 60000);
      if (!ok) throw new Error('login did not complete');
      return { status: 'ready', detail: readyDetail };
    });
  } catch (e) {
    const reason = e && e.message ? e.message : '未知错误';
    return { status: 'blocked', detail: `自动登录检查未通过（${reason}；账号此前正常，可能是检查时页面加载慢、登录表单变化或网站暂时异常，不代表账号被封或密码错误，下次检查会重试）` };
  }
}

async function checkProton() {
  return loginCheck({
    name: 'Proton',
    url: 'https://mail.proton.me',
    username: 'liuyifei.muse@protonmail.com',
    password: process.env.PROTON_PASSWORD,
    userSels: ['input[name="username"]', '#username', 'input[type="email"]', 'input[name="email"]'],
    passSels: ['input[name="password"]', '#password', 'input[type="password"]'],
    readyDetail: 'inbox loads',
  });
}

async function checkTinkerhost() {
  return loginCheck({
    name: 'TinkerHost',
    url: 'https://app.tinkerhost.net',
    username: 'liuyifei.muse@protonmail.com',
    password: process.env.TINKERHOST_PASSWORD,
    userSels: ['input[type="email"]', 'input[name="email"]', '#email', 'input[name="username"]'],
    passSels: ['input[type="password"]', 'input[name="password"]', '#password'],
    readyDetail: 'dashboard loads',
  });
}

async function checkAeonfree() {
  return loginCheck({
    name: 'AeonFree',
    url: 'https://aeonfree.com/login',
    username: 'liuyifei.muse@protonmail.com',
    password: process.env.AEONFREE_PASSWORD,
    userSels: ['input[type="email"]', 'input[name="email"]', '#email', 'input[name="username"]'],
    passSels: ['input[type="password"]', 'input[name="password"]', '#password'],
    readyDetail: 'account loads',
    fallback: async (page) => {
      // If /login has no form, go to the homepage and follow the login link.
      await page.goto('https://aeonfree.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
      const link = page.locator('a:has-text("Login"), a:has-text("Client Area")').first();
      if (await link.count()) {
        await link.click();
        await page.waitForTimeout(2000);
      }
    },
  });
}

// ---------------------------------------------------------------- main
const mode = process.argv[2];

if (mode === 'instabox') {
  const current = readStatus();
  const result = await checkInstabox();
  current.platforms.instabox = result;
  writeStatus(current);
  console.log(`instabox: ${result.status} - ${result.detail}`);
} else if (mode === 'all') {
  // Fast API/HTTP/TCP checks in parallel, then the three browser logins in sequence.
  const [instabox, github, lxi, aws] = await Promise.all([
    checkInstabox(),
    checkGithub(),
    checkLxi(),
    checkAws(),
  ]);
  const proton = await checkProton();
  const tinkerhost = await checkTinkerhost();
  const aeonfree = await checkAeonfree();

  const out = {
    updated_at: new Date().toISOString(),
    platforms: {
      proton,
      github,
      lxi,
      tinkerhost,
      aeonfree,
      cloady: { ...STATIC.cloady },
      instabox,
      kaggle: { ...STATIC.kaggle },
      simular: { ...STATIC.simular },
      colab: { ...STATIC.colab },
      aws,
    },
  };
  writeStatus(out);
  for (const [name, entry] of Object.entries(out.platforms)) {
    console.log(`${name}: ${entry.status} - ${entry.detail}`);
  }
} else {
  console.error('Usage: node scripts/check.mjs instabox|all');
  process.exit(1);
}
