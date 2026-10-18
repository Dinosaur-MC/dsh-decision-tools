/**
 * 在 DSH 更新后重建本项目的 node_modules（只导出依赖闭包，不整份拷 401 MB）。
 *
 * 背景：DSH 桌面版升级会换掉宿主安装布局，工作区里指向旧 `@deepseek-ai/*` 的 junction 随之悬空，
 * `node --test` 会在**导入阶段**就挂（ERR_MODULE_NOT_FOUND），表现为「例数从 359 掉到 239、6 个文件红」。
 *
 * 用法（**必须在 DSH 进程内跑**，因为 `app.asar` 只有 DSH 的 fs 能直读；普通 node 读不了归档）：
 *   const { rebuild } = await import('./scripts/rebuild-node-modules.mjs');
 *   await rebuild();
 * 或在 run_code 里直接执行本文件内容。
 *
 * 算法：从种子包出发，扫描已拷贝文件里的 `from/require/import('x')` 说明符，
 * 把 asar 里存在的包按需拷进 `node_modules/`，BFS 到闭包稳定（不碰 node 内置与相对路径）。
 */
import fs from 'node:fs';
import path from 'node:path';

const SEEDS = ['@deepseek-ai/dsh-tools', '@deepseek-ai/cordis', 'schemastery'];
const BUILTIN = new Set(['fs','path','os','url','util','events','stream','crypto','child_process','buffer','assert','module','process','timers','net','http','https','zlib','readline','worker_threads','perf_hooks','v8','vm','tty','dns','querystring','string_decoder','async_hooks','cluster','dgram','tls','wasi','constants']);

/** 宿主安装布局的候选位置（先 asar，后可能的解包布局）。 */
export function hostNodeModulesCandidates() {
  const res = 'resources';
  const roots = [
    'D:\\Users\\Dinos\\AppData\\Local\\Programs\\DeepSeek Harness',
    path.dirname(path.dirname(process.execPath)),
  ];
  const out = [];
  for (const r of roots) {
    out.push(path.join(r, res, 'app.asar', 'dsh', 'node_modules'));
    out.push(path.join(r, res, 'app', 'dsh', 'node_modules'));
    out.push(path.join(r, res, 'app.asar.unpacked', 'dsh', 'node_modules'));
  }
  return out;
}

export async function rebuild({ hostNodeModules, projectRoot } = {}) {
  const nm = hostNodeModules ?? hostNodeModulesCandidates().find((p) => { try { fs.readdirSync(p); return true; } catch { return false; } });
  if (nm === undefined) throw new Error('找不到宿主 node_modules；请在 DSH 进程内运行（app.asar 只有 DSH 的 fs 能读）。');
  const dstNm = path.join(projectRoot ?? process.cwd(), 'node_modules');
  const specRe = /(?:from\s*|require\(\s*|import\(\s*)['"]([^'"./][^'"]*)['"]/g;
  const seen = new Set();
  const queue = [...SEEDS];
  let copied = 0; let files = 0; let bytes = 0;
  const copyDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, e.name); const d = path.join(to, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') copyDir(s, d); }
      else { try { fs.copyFileSync(s, d); bytes += fs.statSync(d).size; files += 1; } catch { /* 跳过不可复制项 */ } }
    }
  };
  const hasPkg = (name) => { try { return fs.statSync(path.join(dstNm, name, 'package.json')).size > 0; } catch { return false; } };
  while (queue.length > 0 && seen.size < 400) {
    const spec = queue.shift();
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (seen.has(name) || BUILTIN.has(name) || name.startsWith('node:')) continue;
    seen.add(name);
    const dst = path.join(dstNm, name);
    if (!hasPkg(name)) {
      const src = path.join(nm, name);
      if (!fs.existsSync(src)) continue;
      copyDir(src, dst); copied += 1;
    }
    const walk = (d) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|cjs|mjs|json)$/.test(e.name)) {
          let t = ''; try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
          let m; specRe.lastIndex = 0;
          while ((m = specRe.exec(t)) !== null) { const s = m[1]; if (!s.startsWith('.') && !seen.has(s)) queue.push(s); }
        }
      }
    };
    walk(dst);
  }
  return { hostNodeModules: nm, copied, files, bytes, packages: [...seen].sort() };
}

// Windows 上 `file://F:/…` 与 `import.meta.url`（`file:///F:/…`）永不相等 ⇒ 旧判断让 CLI 静默 exit 0。
// 用 pathToFileURL 归一化两侧（node:url）。
const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (invokedDirectly) {
  const r = await rebuild();
  console.log('rebuilt from', r.hostNodeModules);
  console.log('copied', r.copied, 'packages /', r.files, 'files /', (r.bytes / 1048576).toFixed(1), 'MB');
}