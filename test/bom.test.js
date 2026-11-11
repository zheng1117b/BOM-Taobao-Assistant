import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import XLSX from 'xlsx';
import { buildItemKey, buildSearchQueries, buildSearchTerm, extractPackageName, parseBom, scoreProduct } from '../src/bom.js';
import { buildSearchSources, DEFAULT_SEARCH_INTERVAL_MS, identifyPreferredShop, isAccessDeniedText, isLoginUrl, isSecurityVerificationUrl, SHOP_SOURCES } from '../src/taobao.js';
import { cancelJob, createJob } from '../src/jobs.js';

test('解析并合并相同 BOM 物料', () => {
  const file = path.join(os.tmpdir(), `bom-${Date.now()}.xlsx`);
  const rows = [
    ['位号', '型号', '参数', '封装', '数量'],
    ['R1', 'RC0603FR-0710KL', '10K 1%', '0603', 1],
    ['R2', 'RC0603FR-0710KL', '10K 1%', '0603', 2],
    ['C1', '', '100nF 50V', '0603', 1]
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'BOM');
  XLSX.writeFile(workbook, file);
  try {
    const result = parseBom(file, 'sample.xlsx');
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].quantity, 3);
    assert.match(result.items[0].designator, /R1, R2/);
    assert.match(result.items[1].searchTerm, /100nF 50V 0603/);
  } finally {
    fs.unlinkSync(file);
  }
});

test('指定店铺且标题精确命中时获得高匹配分', () => {
  const score = scoreProduct(
    { model: 'STM32F103C8T6', value: '', footprint: 'LQFP48', manufacturer: 'ST' },
    { title: 'ST STM32F103C8T6 LQFP48 原装芯片', preferredShop: true }
  );
  assert.equal(score, 95);
});

test('按指定优先级生成店铺搜索地址', () => {
  assert.deepEqual(SHOP_SOURCES.map(shop => shop.name), ['优信电子', '欧贝顿', 'Risym']);
  const sources = buildSearchSources('STM32F103 C8T6', true);
  assert.deepEqual(sources.map(source => source.name), ['优信电子', '欧贝顿', 'Risym', '淘宝其他店铺']);
  assert.equal(new URL(sources[0].url).hostname, 'youxin-electronic.taobao.com');
  assert.equal(new URL(sources[1].url).hostname, 'oubeidun.tmall.com');
  assert.equal(new URL(sources[2].url).hostname, 'risym.tmall.com');
  assert.equal(new URL(sources[0].url).searchParams.get('keyword'), 'STM32F103 C8T6');
  assert.equal(sources[3].skipFirst, true);
});

test('关闭其他店铺选项时只搜索三家优先店铺', () => {
  const sources = buildSearchSources('0603 10K', false);
  assert.equal(sources.length, 3);
  assert.equal(sources.every(source => source.preferred), true);
});

test('从淘宝商品卡片文字识别优先店铺', () => {
  assert.equal(identifyPreferredShop('企业购 深圳市优信电子科技有限公司').name, '优信电子');
  assert.equal(identifyPreferredShop('天猫 OUBEIDUN 欧贝顿旗舰店').name, '欧贝顿');
  assert.equal(identifyPreferredShop('RISYM 元器件').name, 'Risym');
  assert.equal(identifyPreferredShop('普通电子元件店'), null);
});

test('店铺搜索默认间隔为12秒', () => {
  assert.equal(DEFAULT_SEARCH_INTERVAL_MS, 12000);
});

test('只把真实淘宝登录地址识别为登录拦截', () => {
  assert.equal(isLoginUrl('https://login.taobao.com/member/login.jhtml'), true);
  assert.equal(isLoginUrl('https://login.tmall.com/'), true);
  assert.equal(isLoginUrl('https://youxin-electronic.taobao.com/search.htm?keyword=0603'), false);
  assert.equal(isLoginUrl('https://item.taobao.com/item.htm?id=1&text=登录后查看'), false);
});

test('识别淘宝 punish 滑块验证地址', () => {
  assert.equal(isSecurityVerificationUrl('https://youxin-electronic.taobao.com/search.htm/_____tmd_____/punish?x5secdata=abc'), true);
  assert.equal(isSecurityVerificationUrl('https://youxin-electronic.taobao.com/_____tmd_____/punish?token=abc'), true);
  assert.equal(isSecurityVerificationUrl('https://s.taobao.com/search?q=STM32G031G8U6'), false);
  assert.equal(isSecurityVerificationUrl('https://sec.taobao.com/query.htm?smApp=taobao'), true);
  assert.equal(isSecurityVerificationUrl('https://aq.taobao.com/risk_verify'), true);
});

test('识别淘宝访问被拒绝页面文字', () => {
  assert.equal(isAccessDeniedText('亲，访问被拒绝'), true);
  assert.equal(isAccessDeniedText('当前访问受限，请稍后再试'), true);
  assert.equal(isAccessDeniedText('共搜索到 1 个符合条件的商品'), false);
});

test('搜索词只组合型号、参数、封装和厂商', () => {
  const term = buildSearchTerm({
    designator: 'R1,R2',
    model: 'RC0603FR-0710KL',
    value: '10K 1%',
    footprint: '0603',
    manufacturer: 'YAGEO',
    quantity: 2
  });
  assert.equal(term, 'RC0603FR-0710KL 10K 1% 0603 YAGEO');
  assert.doesNotMatch(term, /R1|R2/);
});

test('运行中的任务可以请求停止', () => {
  const job = createJob('search', 10);
  const stopped = cancelJob(job.id);
  assert.equal(stopped.cancelRequested, true);
  assert.equal(stopped.status, 'stopping');
});

test('相同物料生成稳定的已加购标识', () => {
  const first = buildItemKey({ model: 'RC0603', value: '10K', footprint: '0603', manufacturer: 'YAGEO' });
  const second = buildItemKey({ model: 'rc0603', value: '10k', footprint: '06-03', manufacturer: 'yageo' });
  assert.equal(first, second);
  assert.equal(first.length, 24);
});

test('芯片优先使用精确型号和简化封装搜索', () => {
  const item = {
    model: 'STM32G031G8U6',
    value: 'STM32G031G8U6',
    footprint: 'UFQFPN-28_L4.0-W4.0-P0.50-BL',
    manufacturer: ''
  };
  assert.equal(extractPackageName(item.footprint), 'UFQFPN-28');
  assert.deepEqual(buildSearchQueries(item), [
    'STM32G031G8U6',
    'STM32G031G8U6 UFQFPN-28',
    'STM32G031G8U6 UFQFPN-28_L4.0-W4.0-P0.50-BL'
  ]);
});

test('优信电子精确型号商品获得高分且无关商品保持低分', () => {
  const item = { model: 'STM32G031G8U6', value: '', footprint: 'UFQFPN-28_L4.0-W4.0-P0.50-BL', manufacturer: 'ST' };
  const exact = scoreProduct(item, { title: '原装 STM32G031G8U6 UFQFPN-28 ARM Cortex-M0+ MCU', preferredShop: true, shopPriority: 1 });
  const unrelated = scoreProduct(item, { title: '0805 10UF 106K X5R 贴片陶瓷电容', preferredShop: true, shopPriority: 1 });
  assert.equal(exact, 95);
  assert.equal(unrelated, 20);
});
