import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-browser-test-'));
let context;

try {
  context = await chromium.launchPersistentContext(profileDir, { headless: true, channel: 'msedge' });
  const keeperPage = context.pages()[0] || await context.newPage();

  const firstWorkPage = await context.newPage();
  await firstWorkPage.goto('data:text/html,<title>search-page</title>');
  await firstWorkPage.close();

  const secondWorkPage = await context.newPage();
  await secondWorkPage.goto('data:text/html,<title>cart-page</title>');

  if (keeperPage.isClosed()) throw new Error('保活页面意外关闭');
  if (!context.browser()?.isConnected()) throw new Error('浏览器上下文已断开');
  if (await secondWorkPage.title() !== 'cart-page') throw new Error('无法创建后续工作页面');

  console.log('Microsoft Edge 保活测试通过：关闭检索页后仍可创建加购页');
} finally {
  await context?.close().catch(() => {});
  fs.rmSync(profileDir, { recursive: true, force: true });
}
