/**
 * 契约守卫：`monitor` 的**模型可见参数面**（monitor-tool.js 的 PARAMETERS）与**校验白名单**
 * （validate.js 的 allowedByKind）必须一致。
 *
 * 为什么需要它：真机踩到 `select`/`jobKind` 写在参数面里、却不在校验白名单 ⇒ 模型照参数面传就被
 * 「不接受 select」拒掉，而 lib/monitor.js 里的 selectJobView 成了**不可达代码**。
 * 这类漂移不会让任何单元测试变红（两侧各自自洽），只能靠交叉比对钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARAMETERS } from '../lib/monitor-tool.js';
import { validateMonitorArgs, MONITOR_LIMITS } from '../lib/validate.js';

const SAMPLE = {
  id: 'job-1',
  select: 'newest',
  jobKind: 'monitor',
  path: 'tmp/a.txt',
  startLine: 1,
  endLine: 2,
  pattern: 'tmp/*.txt',
  limit: 2,
  argv: ['bash', '-lc', 'echo x'],
  types: ['job.completed'],
};

const BASE = {
  job: {},
  file: { path: 'tmp/a.txt' },
  glob: { pattern: 'tmp/*.txt' },
  command: { argv: ['bash', '-lc', 'echo x'] },
  events: { types: ['job.completed'] },
};

// 紧凑方言：`PARAMETERS` 是「参数名 → 规格」的**扁平映射**（不是 JSON Schema 的嵌套 properties）。
const sourceProps = PARAMETERS?.source?.properties;

test('参数面的每个 source 键都必须被其声明 kind 的校验白名单接受', () => {
  assert.ok(sourceProps !== null && typeof sourceProps === 'object', 'PARAMETERS.source.properties 必须存在');
  const keys = Object.keys(sourceProps).filter((k) => k !== 'kind');
  assert.ok(keys.length >= 8, '参数面应至少声明 8 个 source 键，实际 ' + keys.length);
  // 参数面是**各 kind 共用的联合体**：每个键用描述前缀声明自己属于哪个 kind（如 'job: …'）。
  // 这里按前缀推断适用范围 —— 既避免把 path 误测到 job 上，也强制「每个键都要标明所属 kind」。
  const problems = [];
  const KIND = '(?:job|file|glob|command|events)';
  for (const key of keys) {
    // ⚠️ 不许「没进 SAMPLE 就跳过」：verifier 证明过 `SAMPLE.limit` 一删、glob 白名单再删 limit，
    // 全套件仍绿（新键忘补 SAMPLE 即静默放行）。缺样本一律算缺口。
    if (SAMPLE[key] === undefined) { problems.push(key + ' ⇒ 缺 SAMPLE 样本（新键必须补样本，否则永远不会被校验）'); continue; }
    const description = String(sourceProps[key]?.description ?? '');
    const prefix = description.match(new RegExp('^(' + KIND + '(?:/' + KIND + ')*):\\s'))?.[1];
    if (prefix === undefined) { problems.push(key + ' ⇒ 描述必须以 kind 前缀开头（如 "job: …"），实际：' + description.slice(0, 40)); continue; }
    for (const declared of prefix.split('/')) {
      const source = { kind: declared, ...BASE[declared], [key]: SAMPLE[key] };
      try {
        validateMonitorArgs({ rubric: 'x', source });
      } catch (error) {
        // 判红**看 kind**、不看文案字面（verifier 证明过把「不接受」改成「不支持」就能骗过旧守卫）。
        const message = String(error?.message ?? error);
        if (error?.kind === 'source_invalid' && message.includes(key)) problems.push(declared + '.' + key + ' ⇒ ' + message.slice(0, 90));
      }
    }
  }
  assert.deepEqual(problems, [], '参数面声明了、校验层却拒收的键（模型照参数面传就会失败）：\n' + problems.join('\n'));
});

test('job 源：select 只能是 newest/oldest、jobKind 必须非空；两者都要被接受', () => {
  assert.doesNotThrow(() => validateMonitorArgs({ rubric: 'x', source: { kind: 'job', select: 'oldest', jobKind: 'pwsh' } }));
  assert.throws(() => validateMonitorArgs({ rubric: 'x', source: { kind: 'job', select: 'middle' } }), (e) => e.kind === 'source_invalid' && /newest 或 oldest/.test(e.message));
  assert.throws(() => validateMonitorArgs({ rubric: 'x', source: { kind: 'job', jobKind: '  ' } }), (e) => e.kind === 'source_invalid' && /jobKind/.test(e.message));
});

test('events 源的 limit 校验层接受（实现里用于 tail 上限）', () => {
  assert.doesNotThrow(() => validateMonitorArgs({ rubric: 'x', source: { kind: 'events', types: ['job.completed'], limit: 5 } }));
});