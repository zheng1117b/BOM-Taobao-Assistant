import path from 'node:path';
import { createHash } from 'node:crypto';
import XLSX from 'xlsx';

const ALIASES = {
  designator: ['designator', 'reference', 'references', 'ref', 'refdes', '位号', '元件位号'],
  model: ['model', 'mpn', 'part number', 'manufacturer part number', '型号', '物料编码', '器件型号'],
  value: ['value', 'comment', 'description', '参数', '规格', '阻值', '容值', '描述'],
  footprint: ['footprint', 'package', 'pattern', '封装', '器件封装'],
  quantity: ['quantity', 'qty', 'count', '数量', '用量'],
  manufacturer: ['manufacturer', 'mfr', 'brand', '厂商', '制造商', '品牌']
};

function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function findColumn(headers, names) {
  const normalized = headers.map(normalizeHeader);
  return names.map(normalizeHeader).map(name => normalized.indexOf(name)).find(index => index >= 0);
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseQuantity(value, designator) {
  const parsed = Number.parseInt(String(value ?? '').replace(/[^0-9]/g, ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const refs = clean(designator).split(/[,，;；\s]+/).filter(Boolean);
  return Math.max(refs.length, 1);
}

function normalizeFootprint(value) {
  return clean(value).toUpperCase().replace(/[_\s-]+/g, '');
}

export function extractPackageName(value) {
  const footprint = clean(value).toUpperCase();
  const knownPackage = footprint.match(/(?:UFQFPN|UQFN|QFN|LQFP|TQFP|SSOP|TSSOP|SOIC|SOP|DFN|BGA|SOT|DIP)[-_]?\d+/i)?.[0];
  if (knownPackage) return knownPackage.replace('_', '-');
  const firstPart = footprint.split(/[_\s]+/).find(Boolean) || '';
  return firstPart.length <= 24 ? firstPart : '';
}

export function buildSearchTerm(item) {
  return [...new Set([item.model, item.value, item.footprint, item.manufacturer].filter(Boolean))].join(' ');
}

export function buildSearchQueries(item) {
  const model = clean(item.model);
  const value = clean(item.value);
  const packageName = extractPackageName(item.footprint);
  const fullTerm = buildSearchTerm(item);
  const queries = model
    ? [model, [model, packageName].filter(Boolean).join(' '), fullTerm]
    : [[value, packageName].filter(Boolean).join(' '), fullTerm, value];
  return [...new Set(queries.filter(Boolean))];
}

export function buildItemKey(item) {
  const identity = [item.model, item.value, normalizeFootprint(item.footprint), item.manufacturer]
    .map(value => clean(value).toUpperCase());
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
}

export function parseBom(filePath, originalName) {
  const extension = path.extname(originalName).toLowerCase();
  const workbook = XLSX.readFile(filePath, extension === '.csv' ? { raw: false, codepage: 65001 } : {});
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  if (!rows.length) throw new Error('BOM 文件为空');

  const headerIndex = rows.findIndex(row => {
    const cells = row.map(normalizeHeader);
    return Object.values(ALIASES).flat().some(alias => cells.includes(normalizeHeader(alias)));
  });
  if (headerIndex < 0) throw new Error('未识别到表头，请确保包含型号、参数、封装、数量或位号等列');

  const headers = rows[headerIndex].map(clean);
  const columns = Object.fromEntries(Object.entries(ALIASES).map(([key, aliases]) => [key, findColumn(headers, aliases)]));
  if (columns.model < 0 && columns.value < 0) throw new Error('至少需要“型号/MPN”或“参数/Value”列');

  const items = rows.slice(headerIndex + 1).map((row, index) => {
    const get = key => columns[key] >= 0 ? clean(row[columns[key]]) : '';
    const item = {
      id: `bom-${index + 1}`,
      row: headerIndex + index + 2,
      designator: get('designator'),
      model: get('model'),
      value: get('value'),
      footprint: get('footprint'),
      manufacturer: get('manufacturer'),
      quantity: parseQuantity(get('quantity'), get('designator'))
    };
    item.searchTerm = buildSearchTerm(item);
    item.key = buildItemKey(item);
    return item;
  }).filter(item => item.searchTerm);

  const merged = new Map();
  for (const item of items) {
    const key = [item.model, item.value, normalizeFootprint(item.footprint), item.manufacturer].map(v => v.toLowerCase()).join('|');
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += item.quantity;
      existing.designator = [existing.designator, item.designator].filter(Boolean).join(', ');
    } else {
      merged.set(key, { ...item });
    }
  }
  return { sheetName: workbook.SheetNames[0], headers, items: [...merged.values()] };
}

export function scoreProduct(item, product) {
  const normalize = value => String(value || '').toUpperCase().replace(/[^A-Z0-9\u4E00-\u9FFF.]+/g, '');
  const title = normalize(product.title);
  const priority = Number(product.shopPriority) || 1;
  let score = product.preferredShop ? Math.max(5, 25 - priority * 5) : 0;
  const model = normalize(item.model);
  const packageName = normalize(extractPackageName(item.footprint));
  const signals = [
    [item.model, 45],
    [item.value, 20],
    [packageName, 20],
    [item.manufacturer, 10]
  ];
  for (const [value, weight] of signals) {
    const token = normalize(value);
    if (token && title.includes(token)) score += weight;
  }
  // 长型号是芯片匹配的强约束，未命中时禁止仅凭店铺或封装获得高分。
  if (model.length >= 6 && !title.includes(model)) score = Math.min(score, 25);
  return Math.min(score, 100);
}
