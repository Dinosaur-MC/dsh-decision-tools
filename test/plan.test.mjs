import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, planAction } from '../lib/plan.js';

test('STRATEGIES 冻结为 auto / inline / scan（scan 是唯一会分块的策略）', () => {
  assert.deepEqual([...STRATEGIES], ['auto', 'inline', 'scan']);
});

test('无失败 → 直发；引用式读取过的材料标 source', () => {
  assert.deepEqual(planAction({}), { action: 'send', reason: 'inline', strategy: 'auto' });
  assert.equal(planAction({ hasSource: true }).reason, 'source');
});

test('溢出 + 可提升 → escalate（与策略无关，inline 也允许换模型）', () => {
  const r = planAction({ failure: { kind: 'context_overflow', actual: 9000 }, escalationEnabled: true, escalation: { ok: true, entry: { model: 'nimble:latest' } } });
  assert.equal(r.action, 'escalate');
  assert.equal(r.reason, 'escalate');
  assert.equal(planAction({ requested: 'inline', failure: { kind: 'context_overflow' }, escalationEnabled: true, escalation: { ok: true } }).action, 'escalate');
});

test('溢出 + 提升用尽 → 扫描（若允许）', () => {
  const r = planAction({ failure: { kind: 'context_overflow' }, escalationEnabled: true, escalation: { ok: false, reason: 'exceeds-largest' } });
  assert.equal(r.action, 'scan');
  assert.equal(r.reason, 'scan-exhausted-escalation');
});

test('显式 scan → 直接扫描（不再试整发）', () => {
  assert.deepEqual(planAction({ requested: 'scan' }), { action: 'scan', reason: 'scan-explicit', strategy: 'scan' });
});

test('inline 禁止扫描：溢出且不可提升 → fail', () => {
  const r = planAction({ requested: 'inline', failure: { kind: 'context_overflow' }, escalationEnabled: true, escalation: { ok: false } });
  assert.equal(r.action, 'fail');
  assert.equal(r.reason, 'scan-not-allowed');
});

test('不可扫描且提升用尽 → fail（reason 说明原因）', () => {
  const r = planAction({ failure: { kind: 'context_overflow' }, escalationEnabled: true, escalation: { ok: false }, scanAvailable: false });
  assert.equal(r.action, 'fail');
  assert.equal(r.reason, 'scan-unavailable');
});

test('非溢出失败一律原样上抛，不套近乎', () => {
  const r = planAction({ failure: { kind: 'timeout' } });
  assert.equal(r.action, 'fail');
  assert.equal(r.reason, 'passthrough:timeout');
  assert.equal(planAction({ failure: { kind: 'model_missing' } }).reason, 'passthrough:model_missing');
});

test('未知策略即报错（参数校验之外的纵深防御）', () => {
  assert.throws(() => planAction({ requested: 'chunk' }), /策略只允许 auto \/ inline \/ scan/);
  // 纯函数契约覆盖：v3 生产只以 requested ∈ {auto, inline} 且失败后调用（见 lib/plan.js 模块头）。
});
