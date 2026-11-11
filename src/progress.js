import path from 'node:path';
import fs from 'node:fs/promises';

function progressFile(root) {
  return path.join(root, 'data', 'added-items.json');
}

export async function readAddedItems(root) {
  try {
    const content = await fs.readFile(progressFile(root), 'utf8');
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function markItemAdded(root, itemKey, details = {}) {
  if (!itemKey) return;
  const items = await readAddedItems(root);
  items[itemKey] = { ...details, addedAt: new Date().toISOString() };
  const file = progressFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(items, null, 2), 'utf8');
}

export async function clearAddedItems(root) {
  await fs.unlink(progressFile(root)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}
