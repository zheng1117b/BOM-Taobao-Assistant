const $ = selector => document.querySelector(selector);
let bomItems = [];
let matches = [];
let activeJobId = null;

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 2800);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

$('#loginBtn').addEventListener('click', async () => {
  try { toast((await api('/api/login', { method: 'POST' })).message); } catch (error) { toast(error.message); }
});

$('#file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const data = await api('/api/bom', { method: 'POST', body: form });
    bomItems = data.items;
    const addedCount = bomItems.filter(item => item.added).length;
    $('#bomMeta').textContent = `${file.name} · 工作表 ${data.sheetName} · 共 ${bomItems.length} 种物料 · 已加购 ${addedCount} 种`;
    renderBomRows();
    $('#bomSection').classList.remove('hidden');
    $('#resultSection').classList.add('hidden');
    $('#cartSection').classList.add('hidden');
  } catch (error) { toast(error.message); }
});

function renderBomRows() {
  $('#bomBody').innerHTML = bomItems.map((item, index) => `<tr><td><input class="bom-check" data-index="${index}" type="checkbox" ${item.added ? '' : 'checked'} ${item.added ? 'disabled' : ''}></td><td><span class="status ${item.added ? 'added' : ''}">${item.added ? '已加购' : '待查找'}</span></td><td>${esc(item.designator || '—')}</td><td><strong>${esc(item.model || item.value)}</strong><div class="muted">${esc(item.model ? item.value : '')}</div></td><td>${esc(item.footprint || '—')}</td><td>${item.quantity}</td><td>${esc(item.searchTerm)}</td></tr>`).join('');
}

$('#resetProgressBtn').addEventListener('click', async () => {
  if (activeJobId) return toast('请先停止当前任务');
  if (!confirm('确定清除全部已加购记录吗？清除后这些物料会重新参与查找。')) return;
  try {
    const result = await api('/api/progress/reset', { method: 'POST' });
    bomItems = bomItems.map(item => ({ ...item, added: false }));
    renderBomRows();
    toast(result.message);
  } catch (error) { toast(error.message); }
});

$('#searchBtn').addEventListener('click', async () => {
  if (activeJobId) return toast('已有任务正在运行，请先停止或等待完成');
  const selected = [...document.querySelectorAll('.bom-check:checked')].map(input => bomItems[Number(input.dataset.index)]);
  if (!selected.length) return toast('请至少选择一项物料');
  try {
    const job = await api('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: selected, globalFallback: $('#fallback').checked }) });
    const done = await watchJob(job.id, '正在匹配淘宝商品');
    matches = done.results;
    renderMatches();
    toast(done.message);
  } catch (error) { toast(error.message); }
});

async function watchJob(id, title) {
  activeJobId = id;
  $('#progressSection').classList.remove('hidden');
  $('#progressTitle').textContent = title;
  $('#stopBtn').classList.remove('hidden');
  $('#stopBtn').disabled = false;
  $('#stopBtn').textContent = '停止当前任务';
  try {
    while (true) {
      const job = await api(`/api/jobs/${id}`);
      $('#progressTitle').textContent = job.status === 'paused' ? '等待登录 / 验证' : title;
      $('#progressText').textContent = job.message || '';
      $('#progressCount').textContent = `${job.completed} / ${job.total}`;
      $('#progressBar').style.width = `${job.total ? job.completed / job.total * 100 : 0}%`;
      if (job.status === 'done' || job.status === 'stopped') return job;
      if (job.status === 'failed') throw new Error(job.error || '任务失败');
      await new Promise(resolve => setTimeout(resolve, 700));
    }
  } finally {
    activeJobId = null;
    $('#stopBtn').classList.add('hidden');
  }
}

$('#stopBtn').addEventListener('click', async () => {
  if (!activeJobId) return;
  $('#stopBtn').disabled = true;
  $('#stopBtn').textContent = '正在停止…';
  try {
    const job = await api(`/api/jobs/${activeJobId}/cancel`, { method: 'POST' });
    $('#progressText').textContent = job.message;
  } catch (error) {
    $('#stopBtn').disabled = false;
    $('#stopBtn').textContent = '停止当前任务';
    toast(error.message);
  }
});

function renderMatches() {
  if (!matches.length) {
    $('#results').innerHTML = '<p class="error">任务已停止，尚未产生匹配结果。完成验证后可重新点击“开始匹配”。</p>';
    $('#resultSection').classList.remove('hidden');
    return;
  }
  $('#results').innerHTML = matches.map((match, index) => {
    const options = match.candidates.map((candidate, candidateIndex) => `<option value="${candidateIndex}" ${candidateIndex === 0 ? 'selected' : ''}>【${esc(candidate.shopName || (candidate.preferredShop ? '优先店铺' : '淘宝全站'))}】 ${candidate.score}分 · ${esc(candidate.title)}${candidate.price ? ` · ¥${candidate.price}` : ''}</option>`).join('');
    const first = match.candidates[0];
    return `<div class="result"><input class="match-check" data-index="${index}" type="checkbox" ${first?.score >= 45 ? 'checked' : ''} ${first ? '' : 'disabled'}><div><h3>${esc(match.item.model || match.item.value)}</h3><p>${esc(match.item.value)} · ${esc(match.item.footprint)} · 数量 ${match.item.quantity}</p><p>${esc(match.item.designator)}</p></div><div>${first ? `<div class="candidate-row"><select class="candidate" data-index="${index}">${options}</select><span class="score ${first.score < 60 ? 'low' : ''}" id="score-${index}">${first.score} 分</span><a id="link-${index}" href="${escAttr(first.url)}" target="_blank">打开核对</a></div>${first.score < 45 ? '<p class="error">没有可靠匹配，已取消默认勾选，请人工核对。</p>' : ''}` : `<p class="error">${esc(match.error || '未找到候选商品')}</p>`}</div></div>`;
  }).join('');
  document.querySelectorAll('.candidate').forEach(select => select.addEventListener('change', () => {
    const index = Number(select.dataset.index);
    const candidate = matches[index].candidates[Number(select.value)];
    $(`#score-${index}`).textContent = `${candidate.score} 分`;
    $(`#score-${index}`).classList.toggle('low', candidate.score < 60);
    $(`#link-${index}`).href = candidate.url;
  }));
  $('#resultSection').classList.remove('hidden');
  $('#resultSection').scrollIntoView({ behavior: 'smooth' });
}

$('#cartBtn').addEventListener('click', async () => {
  if (activeJobId) return toast('已有任务正在运行，请先停止或等待完成');
  const selections = [...document.querySelectorAll('.match-check:checked')].map(check => {
    const index = Number(check.dataset.index);
    const select = document.querySelector(`.candidate[data-index="${index}"]`);
    return {
      ...matches[index].candidates[Number(select.value)],
      quantity: matches[index].item.quantity,
      bomKey: matches[index].item.key,
      searchTerm: matches[index].item.searchTerm
    };
  });
  if (!selections.length) return toast('请至少确认一个匹配商品');
  if (!confirm(`即将把 ${selections.length} 种商品加入淘宝购物车，不会提交订单。是否继续？`)) return;
  try {
    const job = await api('/api/cart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selections }) });
    const done = await watchJob(job.id, '正在加入购物车');
    const addedKeys = new Set(done.results.filter(result => result.status === 'added').map(result => result.selection.bomKey));
    bomItems = bomItems.map(item => addedKeys.has(item.key) ? { ...item, added: true } : item);
    renderBomRows();
    $('#cartResults').innerHTML = done.results.map((result, index) => `<div class="cart-item ${result.status}"><span>${esc(result.selection.title)}</span><strong>${esc(result.message)}</strong>${result.status === 'needs_user' && result.selection.bomKey ? `<button class="mark-added" data-index="${index}">我已手动加购</button>` : ''}</div>`).join('');
    document.querySelectorAll('.mark-added').forEach(button => button.addEventListener('click', async () => {
      const result = done.results[Number(button.dataset.index)];
      try {
        const response = await api('/api/progress/mark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result.selection)
        });
        bomItems = bomItems.map(item => item.key === result.selection.bomKey ? { ...item, added: true } : item);
        renderBomRows();
        button.disabled = true;
        button.textContent = '已记录';
        toast(response.message);
      } catch (error) { toast(error.message); }
    }));
    $('#cartSection').classList.remove('hidden');
    $('#cartSection').scrollIntoView({ behavior: 'smooth' });
    toast(done.message);
  } catch (error) { toast(error.message); }
});

function esc(value) { const node = document.createElement('span'); node.textContent = String(value ?? ''); return node.innerHTML; }
function escAttr(value) { return esc(value).replace(/"/g, '&quot;'); }
