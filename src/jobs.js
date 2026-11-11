import { randomUUID } from 'node:crypto';

const jobs = new Map();

export function createJob(type, total) {
  const job = { id: randomUUID(), type, status: 'running', total, completed: 0, message: '任务已开始', results: [], error: null, cancelRequested: false, createdAt: new Date().toISOString() };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id);
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) Object.assign(job, patch);
  return job;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (!['done', 'failed', 'stopped'].includes(job.status)) {
    job.cancelRequested = true;
    job.status = 'stopping';
    job.message = '正在停止当前任务…';
  }
  return job;
}
