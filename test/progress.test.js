import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearAddedItems, markItemAdded, readAddedItems } from '../src/progress.js';

test('已加购物料可以持久化并清除', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-progress-test-'));
  try {
    await markItemAdded(root, 'item-a', { title: '0603 10K', quantity: 5 });
    await markItemAdded(root, 'item-b', { title: '0603 100nF', quantity: 2 });
    const items = await readAddedItems(root);
    assert.equal(items['item-a'].quantity, 5);
    assert.equal(items['item-b'].title, '0603 100nF');
    await clearAddedItems(root);
    assert.deepEqual(await readAddedItems(root), {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
