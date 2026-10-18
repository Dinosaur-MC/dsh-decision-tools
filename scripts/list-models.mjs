#!/usr/bin/env node
/**
 * 列出本机 Ollama 已装的 decision 模型，并生成可直接粘进 `Config.ladder` 的片段。
 *
 * 用法（普通 node 即可，不需要 DSH 进程）：
 *   node scripts/list-models.mjs                 # 表格
 *   node scripts/list-models.mjs --json          # {models, ladder}
 *   node scripts/list-models.mjs --base-url http://host:11434
 *
 * 背景：插件的默认模型与升档阶梯是**快照**（见 README 的 ladder 行），换机器/换模型后应当
 * 先看事实再配置，而不是猜型号或猜 num_ctx。
 */
import { discoverModels, formatLadder, DEFAULT_OLLAMA_BASE } from '../lib/ollama.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
if (has('--help') || has('-h')) {
  console.log('用法: node scripts/list-models.mjs [--json] [--base-url <url>]');
  process.exit(0);
}
const baseUrl = valueOf('--base-url') ?? DEFAULT_OLLAMA_BASE;
try {
  const models = await discoverModels({ baseUrl });
  const ladder = formatLadder(models);
  if (has('--json')) {
    console.log(JSON.stringify({ baseUrl, models, ladder }, null, 2));
  } else {
    if (models.length === 0) {
      console.log('没有发现任何模型。先 ollama pull <model>，或检查 --base-url。');
    } else {
      const width = Math.max(...models.map((m) => m.name.length));
      console.log('模型'.padEnd(width) + '  上下文     参数        大小');
      for (const m of models) {
        const ctx = Number.isFinite(m.contextLength) ? String(m.contextLength) : (m.metaError ? '(' + m.metaError + ')' : '未知');
        const size = Number.isFinite(m.sizeBytes) ? (m.sizeBytes / 1024 ** 3).toFixed(1) + ' GB' : '-';
        console.log(m.name.padEnd(width) + '  ' + ctx.padEnd(10) + (m.parameters ?? '-').padEnd(11) + size);
      }
    }
    console.log('');
    console.log('可直接粘进 Config.ladder：');
    console.log(JSON.stringify(ladder, null, 2));
    console.log('');
    console.log('（numCtx 取 /api/show 的**声明**值，是上限；Ollama 运行时 num_ctx 常更小（默认 8192）。');
  }
} catch (error) {
  console.error('发现模型失败：' + String(error && error.message ? error.message : error));
  if (error && error.hint) console.error('提示：' + error.hint);
  process.exit(1);
}