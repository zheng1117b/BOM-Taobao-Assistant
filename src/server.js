import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseBom } from './bom.js';
import { addToCart, openLogin, searchItem } from './taobao.js';
import { cancelJob, createJob, getJob, updateJob } from './jobs.js';
import { clearAddedItems, markItemAdded, readAddedItems } from './progress.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const uploadDir = path.join(root, 'uploads');
await fs.mkdir(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir, limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(null, /\.(xlsx?|csv)$/i.test(file.originalname)) });
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(root, 'public')));

app.post('/api/bom', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择 XLSX、XLS 或 CSV 文件' });
  try {
    const parsed = parseBom(req.file.path, req.file.originalname);
    const addedItems = await readAddedItems(root);
    parsed.items = parsed.items.map(item => ({ ...item, added: Boolean(addedItems[item.key]) }));
    res.json(parsed);
  } catch (error) {
    res.status(400).json({ error: error.message });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

app.post('/api/login', async (_req, res) => {
  try { res.json(await openLogin(root)); } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/search', async (req, res) => {
  const requestedItems = Array.isArray(req.body.items) ? req.body.items : [];
  const addedItems = await readAddedItems(root);
  const items = requestedItems.filter(item => !item.added && !addedItems[item.key]);
  if (!items.length) return res.status(400).json({ error: '所选物料均已加入购物车，没有需要继续检索的项目' });
  const job = createJob('search', items.length);
  res.status(202).json(job);
  void (async () => {
    for (let index = 0; index < items.length; index += 1) {
      if (job.cancelRequested) {
        updateJob(job.id, { status: 'stopped', message: '检索已由用户停止' });
        return;
      }
      const item = items[index];
      try {
        updateJob(job.id, { message: `正在检索 ${item.searchTerm}` });
        const candidates = await searchItem(item, root, {
          globalFallback: req.body.globalFallback !== false,
          onStatus: message => updateJob(job.id, { message }),
          onPause: message => updateJob(job.id, { status: 'paused', stopReason: 'verification', message }),
          onResume: message => updateJob(job.id, { status: 'running', stopReason: null, message }),
          shouldStop: () => Boolean(getJob(job.id)?.cancelRequested)
        });
        job.results.push({ item, candidates, selected: candidates[0] || null });
      } catch (error) {
        job.results.push({ item, candidates: [], selected: null, error: error.message });
        if (error.code === 'ACCESS_DENIED') {
          updateJob(job.id, { status: 'stopped', stopReason: 'access_denied', message: error.message });
          return;
        }
        if (error.code === 'TASK_STOPPED') {
          updateJob(job.id, { status: 'stopped', stopReason: 'user', message: '检索已由用户停止' });
          return;
        }
      }
      updateJob(job.id, { completed: index + 1 });
    }
    updateJob(job.id, { status: 'done', message: '检索完成，请审核匹配结果' });
  })().catch(error => updateJob(job.id, { status: 'failed', error: error.message }));
});

app.post('/api/cart', (req, res) => {
  const selections = Array.isArray(req.body.selections) ? req.body.selections.filter(item => item?.url) : [];
  if (!selections.length) return res.status(400).json({ error: '没有已确认的商品' });
  const job = createJob('cart', selections.length);
  res.status(202).json(job);
  void (async () => {
    for (let index = 0; index < selections.length; index += 1) {
      if (job.cancelRequested) {
        updateJob(job.id, { status: 'stopped', message: '加购任务已由用户停止' });
        return;
      }
      const selection = selections[index];
      try {
        updateJob(job.id, { message: `正在加购 ${selection.title}` });
        const cartResult = await addToCart({
          ...selection,
          onStatus: message => updateJob(job.id, { message }),
          onPause: message => updateJob(job.id, { status: 'paused', stopReason: 'verification', message }),
          onResume: message => updateJob(job.id, { status: 'running', stopReason: null, message }),
          shouldStop: () => Boolean(getJob(job.id)?.cancelRequested)
        }, root);
        job.results.push({
          selection,
          ...cartResult
        });
        if (cartResult.status === 'added' && selection.bomKey) {
          await markItemAdded(root, selection.bomKey, {
            title: selection.title,
            url: selection.url,
            quantity: selection.quantity,
            searchTerm: selection.searchTerm || ''
          });
        }
      } catch (error) {
        job.results.push({ selection, status: 'failed', message: error.message });
        if (error.code === 'ACCESS_DENIED') {
          updateJob(job.id, { status: 'stopped', stopReason: 'access_denied', message: '淘宝访问被拒绝，加购任务已停止，请稍后再试' });
          return;
        }
        if (error.code === 'TASK_STOPPED') {
          updateJob(job.id, { status: 'stopped', stopReason: 'user', message: '加购任务已由用户停止' });
          return;
        }
      }
      updateJob(job.id, { completed: index + 1 });
    }
    updateJob(job.id, { status: 'done', message: '加购流程已完成' });
  })().catch(error => updateJob(job.id, { status: 'failed', error: error.message }));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在或服务已重启' });
  res.json(job);
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = cancelJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在或服务已重启' });
  res.json(job);
});

app.post('/api/progress/reset', async (_req, res) => {
  await clearAddedItems(root);
  res.json({ ok: true, message: '已清除全部已加购记录' });
});

app.post('/api/progress/mark', async (req, res) => {
  const { bomKey, title = '', url = '', quantity = 1, searchTerm = '' } = req.body || {};
  if (!bomKey) return res.status(400).json({ error: '缺少物料标识，无法记录加购状态' });
  await markItemAdded(root, bomKey, { title, url, quantity, searchTerm, manual: true });
  res.json({ ok: true, message: '已记录为手动加购，后续将自动跳过' });
});

app.use((error, _req, res, _next) => res.status(500).json({ error: error.message || '服务器错误' }));
const port = Number(process.env.PORT || 3210);
const homeUrl = `http://127.0.0.1:${port}`;

function openInEdge(url) {
  const candidates = [
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  const edgePath = candidates.find(candidate => candidate && existsSync(candidate));
  const opener = edgePath
    ? spawn(edgePath, [url], { detached: true, stdio: 'ignore', windowsHide: false })
    : spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', `microsoft-edge:${url}`], { detached: true, stdio: 'ignore', windowsHide: true });
  opener.on('error', error => console.warn(`无法自动打开 Microsoft Edge：${error.message}`));
  opener.unref();
}

app.listen(port, '127.0.0.1', () => {
  console.log(`BOM 淘宝助手已启动：${homeUrl}`);
  if (process.env.BOM_NO_BROWSER !== '1') {
    openInEdge(homeUrl);
  }
});
