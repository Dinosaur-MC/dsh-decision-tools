import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertModeExclusive, validateQuestions } from '../lib/validate.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const VALIDATE = path.join(ROOT, 'lib', 'validate.js');

/** 扫描所有 `new DecisionValidationError(...)`，返回缺显式 kind 的调用点行号。 */
export function throwsWithoutKind(source) {
  const MARK = 'new DecisionValidationError(';
  const missing = [];
  let i = 0;
  while (true) {
    const k = source.indexOf(MARK, i);
    if (k < 0) break;
    let depth = 1; let j = k + MARK.length; let quote = null;
    for (; j < source.length; j += 1) {
      const ch = source[j];
      if (quote !== null) { if (ch === '\\') { j += 1; continue; } if (ch === quote) quote = null; continue; }
      if (ch === '\'' || ch === '\"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth === 0) break; }
    }
    const inner = source.slice(k + MARK.length, j);
    if (!/kind:/.test(inner)) missing.push(source.slice(0, k).split('\n').length);
    i = j + 1;
  }
  return missing;
}

test('每个 DecisionValidationError 都必须显式给 kind（不靠默认值）', () => {
  const missing = throwsWithoutKind(fs.readFileSync(VALIDATE, 'utf8'));
  assert.deepEqual(missing, [], '这些行缺少显式 kind：' + JSON.stringify(missing));
});

test('kind 取值必须在已登记的清单里（防止拼写漂移）', () => {
  const KINDS = new Set(['invalid_request','mode_invalid','mode_missing','mode_conflict','criteria_requires_items_mode','criteria_not_allowed','type_requires_items_mode','material_invalid','material_conflict','source_invalid','source_missing','source_empty','source_outside_root','source_too_large','upstream_invalid','upstream_self_recursion','upstream_depth_exceeded','monitor_invalid','quick_over_budget','context_overflow','too_large','model_missing','model_broken','escalation_exhausted','tool_service_missing','skill_missing','pipe_unavailable','timeout','transport','bad_port','bad_config','http_error','server_error','bad_response','unreachable','aborted','spill_write_failed','spill_read_failed','spill_path_rejected','spill_dir_missing','monitor_decide_failed','monitor_body_too_large','command_tool_failed','directory','file','glob','inline','hit']);
  const source = fs.readFileSync(VALIDATE, 'utf8');
  const used = [...source.matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]);
  const unknown = [...new Set(used)].filter((k) => !KINDS.has(k));
  assert.deepEqual(unknown, [], '未登记的 kind：' + JSON.stringify(unknown));
});

test('数量/形态约束统一为 mode_invalid（items 与 questions 同口径）', () => {
  const noul = (i) => ({ name: 'q' + i, type: 'noul', instructions: 'x' });
  const cases = [
    { questions: Array.from({ length: 65 }, (_, i) => noul(i)) },
    { questions: 'nope' },

  ];
  for (const extra of cases) {
    let caught;
    try { validateQuestions(extra.questions); } catch (error) { caught = error; }
    assert.ok(caught, '必须被拒：' + JSON.stringify(extra).slice(0, 60));
    assert.equal(caught.kind, 'mode_invalid', '数量/形态必须统一为 mode_invalid');
  }
  // batch 模式：items 超限同样必须是 mode_invalid（与 questions 同口径）。
  let itemsError;
  try { assertModeExclusive({ material: 'm', rubric: 'x', type: 'noul', items: Array.from({ length: 65 }, (_, i) => ({ id: 'i' + i })) }); } catch (error) { itemsError = error; }
  assert.ok(itemsError, 'items 超限必须被拒');
  assert.equal(itemsError.kind, 'mode_invalid');
});