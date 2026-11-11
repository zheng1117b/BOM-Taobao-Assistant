import path from 'node:path';
import { chromium } from 'playwright';
import { buildSearchQueries, scoreProduct } from './bom.js';

export const SHOP_SOURCES = [
  { name: '优信电子', baseUrl: 'https://youxin-electronic.taobao.com/search.htm', priority: 1, patterns: ['优信电子', '深圳市优信电子科技'] },
  { name: '欧贝顿', baseUrl: 'https://oubeidun.tmall.com/search.htm', priority: 2, patterns: ['欧贝顿', 'OUBEIDUN'] },
  { name: 'Risym', baseUrl: 'https://risym.tmall.com/search.htm', priority: 3, patterns: ['RISYM'] }
];

let contextPromise;
let activeContext;
let keeperPage;
export const DEFAULT_SEARCH_INTERVAL_MS = 12000;
let nextSearchAllowedAt = 0;
const blockedHosts = new Map();

function stoppedError() {
  const error = new Error('用户已停止当前任务');
  error.code = 'TASK_STOPPED';
  return error;
}

function throwIfStopped(options) {
  if (options.shouldStop?.()) throw stoppedError();
}

function clearContext(context) {
  if (!context || activeContext === context) {
    contextPromise = null;
    activeContext = null;
    keeperPage = null;
  }
}

async function launchContext(dataDir) {
  const profileDir = path.join(dataDir, '.browser-data');
  const launchOptions = {
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled']
  };
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, { ...launchOptions, channel: 'msedge' });
  } catch (edgeError) {
    console.warn(`Microsoft Edge 启动失败，回退到 Chromium：${edgeError.message}`);
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
  }
  activeContext = context;
  context.on('close', () => clearContext(context));
  keeperPage = context.pages().find(page => !page.isClosed()) || await context.newPage();
  return context;
}

async function ensureKeeper(context) {
  if (keeperPage && !keeperPage.isClosed()) return;
  keeperPage = context.pages().find(page => !page.isClosed()) || await context.newPage();
}

async function getContext(dataDir) {
  if (contextPromise) {
    try {
      const context = await contextPromise;
      if (!context.browser()?.isConnected()) throw new Error('浏览器已关闭');
      await ensureKeeper(context);
      return context;
    } catch {
      clearContext(activeContext);
    }
  }
  contextPromise = launchContext(dataDir).catch(error => {
    clearContext();
    throw error;
  });
  return await contextPromise;
}

function globalSearchUrl(keyword) {
  return `https://s.taobao.com/search?q=${encodeURIComponent(keyword)}`;
}

function shopSearchUrl(shop, keyword) {
  const url = new URL(shop.baseUrl);
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('viewType', 'grid');
  return url.toString();
}

export function buildSearchSources(keyword, globalFallback = true) {
  const sources = SHOP_SOURCES.map(shop => ({
    name: shop.name,
    priority: shop.priority,
    preferred: true,
    skipFirst: false,
    allowOtherShops: false,
    url: shopSearchUrl(shop, keyword)
  }));
  if (globalFallback) {
    sources.push({
      name: '淘宝其他店铺',
      priority: 99,
      preferred: false,
      skipFirst: true,
      allowOtherShops: true,
      url: globalSearchUrl(keyword)
    });
  }
  return sources;
}

export function identifyPreferredShop(text) {
  const comparable = String(text || '').toUpperCase().replace(/\s+/g, '');
  return SHOP_SOURCES.find(shop => shop.patterns.some(pattern => comparable.includes(pattern.toUpperCase().replace(/\s+/g, '')))) || null;
}

function sourceUrlForQuery(source, query) {
  const url = new URL(source.url);
  if (url.hostname === 's.taobao.com') url.searchParams.set('q', query);
  else url.searchParams.set('keyword', query);
  return url.toString();
}

async function createPage(dataDir) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const context = await getContext(dataDir);
    try {
      return await context.newPage();
    } catch (error) {
      lastError = error;
      clearContext(context);
    }
  }
  throw lastError || new Error('无法启动淘宝浏览器');
}

export function isLoginUrl(url) {
  try {
    const hostname = new URL(String(url)).hostname;
    return /(^|\.)login\.(taobao|tmall)\.com$/i.test(hostname) || hostname === 'passport.taobao.com';
  } catch {
    return false;
  }
}

export function isSecurityVerificationUrl(url) {
  try {
    const parsed = new URL(String(url));
    const address = `${parsed.pathname}${parsed.search}`;
    const securityHost = /^(?:sec|aq)\.taobao\.com$/i.test(parsed.hostname);
    return securityHost || /(?:^|\/)punish(?:[/?]|$)|x5secdata|captcha|security[_-]?verify|risk[_-]?verify/i.test(address);
  } catch {
    return false;
  }
}

function accessDeniedError(message = '淘宝首页访问被拒绝，搜索任务已停止') {
  const error = new Error(message);
  error.code = 'ACCESS_DENIED';
  return error;
}

async function throttleSearch(page, options = {}) {
  let remaining = nextSearchAllowedAt - Date.now();
  while (remaining > 0) {
    throwIfStopped(options);
    options.onStatus?.(`为避免访问频繁，等待 ${Math.ceil(remaining / 1000)} 秒后继续搜索`);
    await page.waitForTimeout(Math.min(1000, remaining));
    remaining = nextSearchAllowedAt - Date.now();
  }
}

export function isAccessDeniedText(text) {
  return /(?:访问|请求)(?:已经|已)?被拒绝|拒绝访问|访问受限/.test(String(text || ''));
}

function markHostBlocked(url, durationMs = 30 * 60 * 1000) {
  const hostname = new URL(url).hostname;
  blockedHosts.set(hostname, Date.now() + durationMs);
}

function hostCooldownRemaining(url) {
  const hostname = new URL(url).hostname;
  const deadline = blockedHosts.get(hostname) || 0;
  if (deadline <= Date.now()) {
    blockedHosts.delete(hostname);
    return 0;
  }
  return deadline - Date.now();
}

async function getInterruptionReason(page) {
  if (page.isClosed()) return '浏览器页面已关闭';
  if (isLoginUrl(page.url())) return '淘宝登录';

  const pageTitle = await page.title().catch(() => '');
  const verificationText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  // 同一个 punish 地址既可能显示滑块，也可能在失败后显示拒绝；拒绝状态优先判断。
  if (isAccessDeniedText(pageTitle)) return '淘宝访问被拒绝';
  if (isAccessDeniedText(verificationText)) return '淘宝访问被拒绝';
  if (isSecurityVerificationUrl(page.url())) return '淘宝滑块安全验证';
  if (/验证码拦截|安全验证|访问验证/.test(pageTitle)) return '淘宝滑块安全验证';
  if (/请拖动.+滑块完成验证|通过验证以确保正常访问|验证码拦截|确认不是机器人|请完成(?:以下)?验证|网络环境存在风险/.test(verificationText)) return '淘宝滑块安全验证';

  const securitySelectors = [
    '#nc_1_wrapper',
    '.nc_wrapper',
    '[class*="captcha"]',
    '[id*="captcha"]',
    'iframe[src*="captcha"]',
    'iframe[src*="punish"]'
  ];
  for (const selector of securitySelectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return '安全验证';
  }

  const loginSelectors = [
    'input[type="password"]',
    'iframe[src*="login.taobao.com"]',
    'iframe[src*="login.tmall.com"]'
  ];
  for (const selector of loginSelectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return '淘宝登录';
  }
  return null;
}

async function waitForUserAccess(page, targetUrl, options = {}) {
  throwIfStopped(options);
  let reason = await getInterruptionReason(page);
  if (!reason) return;

  if (reason === '淘宝访问被拒绝') {
    throw accessDeniedError();
  }

  const timeoutMs = options.verificationTimeoutMs || 30 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  options.onPause?.(`${reason}：查找已暂停，请在弹出的 Edge 中完成，之后会自动继续`);

  while (Date.now() < deadline) {
    throwIfStopped(options);
    if (page.isClosed()) throw new Error('验证页面已关闭，请重新执行当前任务');
    await page.waitForTimeout(1500);
    reason = await getInterruptionReason(page);
    if (!reason) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);
      const repeatedReason = await getInterruptionReason(page);
      if (!repeatedReason) {
        options.onResume?.('验证已完成，正在从暂停位置继续查找');
        return;
      }
      reason = repeatedReason;
      options.onPause?.(`${reason}仍未完成，查找继续保持暂停`);
    }
  }
  throw new Error('等待登录或安全验证超时，请完成后重新执行当前任务');
}

async function collectProducts(page, source) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2200);
  const selectors = [
    'a[href*="item.taobao.com/item.htm"]',
    'a[href*="detail.tmall.com/item.htm"]',
    '[class*="item"] a[href*="item.htm"]'
  ];
  for (const selector of selectors) {
    const products = await page.locator(selector).evaluateAll((links, sourceInfo) => {
      const productsByUrl = new Map();
      for (const link of links) {
        const href = link.href;
        if (!href) continue;
        const container = link.closest('[class*="item"], [class*="Item"], [class*="Card"], .detail, li, article') || link.parentElement || link;
        const titleNode = container.querySelector('[class*="title"], [class*="Title"], .detail a, .item-name');
        const sellerNode = container.querySelector('[class*="shop"], [class*="Shop"], [class*="seller"], [class*="Seller"]');
        const candidates = [
          link.getAttribute('title'),
          link.getAttribute('aria-label'),
          link.innerText,
          link.querySelector('img')?.getAttribute('alt'),
          titleNode?.textContent,
          container.innerText
        ].map(value => String(value || '').trim().replace(/\s+/g, ' ')).filter(value => value.length >= 3);
        const title = candidates.sort((a, b) => b.length - a.length)[0] || '';
        if (!title) continue;
        const priceMatch = (container.innerText || '').match(/[¥￥]\s*([0-9.]+)/);
        const existing = productsByUrl.get(href);
        const product = {
          title: title.slice(0, 240),
          url: href,
          price: priceMatch?.[1] || '',
          sellerText: `${sellerNode?.textContent || ''} ${container.innerText || ''}`.trim().slice(0, 500),
          matchedQuery: sourceInfo.query
        };
        if (!existing || product.title.length > existing.title.length) productsByUrl.set(href, product);
      }
      const values = [...productsByUrl.values()];
      // 淘宝首页搜索首位通常是推广广告，按用户要求始终排除。
      return (sourceInfo.skipFirst ? values.slice(1) : values).slice(0, 12);
    }, source).catch(() => []);
    if (products.length) return products;
  }
  return [];
}

export async function searchItem(item, dataDir, options = {}) {
  const page = await createPage(dataDir);
  try {
    const queries = buildSearchQueries(item);
    const sources = buildSearchSources(queries[0], options.globalFallback !== false);
    const lowConfidenceProducts = [];
    for (const source of sources) {
      const cooldown = hostCooldownRemaining(source.url);
      if (cooldown > 0) {
        if (source.preferred) {
          options.onStatus?.(`${source.name}处于访问冷却期，本轮跳过并继续下一家店`);
          continue;
        }
        const remainingMinutes = Math.max(1, Math.ceil(cooldown / 60000));
        throw accessDeniedError(`淘宝全站搜索仍在访问冷却期（约${remainingMinutes}分钟），搜索任务已停止`);
      }
      for (const query of queries) {
        throwIfStopped(options);
        const searchUrl = sourceUrlForQuery(source, query);
        options.onStatus?.(`正在 ${source.name} 搜索：${query}`);
        await throttleSearch(page, options);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        try {
          await waitForUserAccess(page, searchUrl, options);
        } catch (error) {
          if (error.code === 'ACCESS_DENIED') {
            markHostBlocked(searchUrl);
            if (source.preferred) {
              options.onStatus?.(`${source.name}访问被拒绝，已冷却30分钟并继续下一家店`);
              break;
            }
            options.onStatus?.('淘宝全站搜索访问被拒绝，已冷却30分钟并停止搜索');
            throw accessDeniedError('淘宝全站搜索访问被拒绝，搜索任务已停止');
          }
          throw error;
        }
        const collectedProducts = await collectProducts(page, { ...source, query });
        nextSearchAllowedAt = Date.now() + (Number(options.searchIntervalMs) || DEFAULT_SEARCH_INTERVAL_MS);
        let products = collectedProducts
          .map(product => {
            const preferredShop = source.preferred
              ? { name: source.name, priority: source.priority }
              : identifyPreferredShop(`${product.sellerText} ${product.title}`);
            const enriched = {
              ...product,
              preferredShop: Boolean(preferredShop),
              shopName: preferredShop?.name || '淘宝其他店铺',
              shopPriority: preferredShop?.priority || 99
            };
            return { ...enriched, score: scoreProduct(item, enriched) };
          });
        if (!source.allowOtherShops) products = products.filter(product => product.preferredShop);
        products = products
          .sort((a, b) => b.score - a.score);
        if (products.some(product => product.score >= 45)) return products;
        lowConfidenceProducts.push(...products);
      }
    }
    const uniqueProducts = new Map();
    for (const product of lowConfidenceProducts.sort((a, b) => b.score - a.score)) {
      if (!uniqueProducts.has(product.url)) uniqueProducts.set(product.url, product);
    }
    return [...uniqueProducts.values()].slice(0, 12);
  } finally {
    await page.close().catch(() => {});
  }
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count() && await locator.isVisible().catch(() => false)) {
      await locator.click();
      return true;
    }
  }
  return false;
}

export async function addToCart(selection, dataDir) {
  throwIfStopped(selection);
  const page = await createPage(dataDir);
  await page.goto(selection.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitForUserAccess(page, selection.url, selection);
  await page.waitForTimeout(1800);
  throwIfStopped(selection);

  // 有 SKU 时不擅自选择，避免把封装、阻值或数量选错。
  const skuGroups = page.locator('[class*="sku"] [class*="prop"], [class*="Sku"] [class*="value"]');
  const unselected = await skuGroups.count().catch(() => 0);
  if (unselected > 1) {
    return { status: 'needs_user', message: '商品包含规格选项，请在浏览器中确认型号/封装后手动点击加入购物车', url: selection.url };
  }

  const quantity = Math.max(1, Number(selection.quantity) || 1);
  const quantityInput = page.locator('input[type="number"], input[class*="quantity"], input[class*="amount"]').first();
  if (await quantityInput.isVisible().catch(() => false)) await quantityInput.fill(String(quantity)).catch(() => {});

  const clicked = await clickFirstVisible(page, [
    'button:has-text("加入购物车")',
    'a:has-text("加入购物车")',
    '[class*="addCart"]',
    '[class*="AddCart"]'
  ]);
  if (!clicked) return { status: 'needs_user', message: '未定位到加购按钮，请在浏览器中手动确认', url: selection.url };
  await page.waitForTimeout(1200);
  await page.close().catch(() => {});
  return { status: 'added', message: `已提交加购，数量 ${quantity}`, url: selection.url };
}

export async function openLogin(dataDir) {
  const page = await createPage(dataDir);
  await page.goto('https://login.taobao.com/', { waitUntil: 'domcontentloaded' });
  return { ok: true, message: '淘宝登录页已打开，请在浏览器中完成登录' };
}
