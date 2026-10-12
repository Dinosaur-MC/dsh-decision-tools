import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAnswers } from '../lib/render.js';
import { LIMITS } from '../lib/validate.js';

/** 取出渲染出的纯文本。 */
function textOf(value) {
  const blocks = renderAnswers({}, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.equal(typeof blocks[0].text, 'string');
  return blocks[0].text;
}

const USAGE = { input_tokens: 799, output_tokens: 4 };

test('choice：给出结论、降序概率与 confidence', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: {
      label: {
        type: 'choice',
        choice: 'bug',
        probabilities: { billing: 0.0063, bug: 0.9593, account: 0.0343 },
        confidence: 0.8292,
      },
    },
    usage: USAGE,
  });
  assert.match(text, /^label\s+choice\s+bug\s+p=\{bug=0\.9593, account=0\.0343, billing=0\.0063\}\s+conf=0\.829$/m);
  assert.match(text, /usage: input_tokens=799 output_tokens=4/);
});

test('noul：渲染成 P(true) 数值而不是布尔字面量', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: { refund: { type: 'noul', noul: 0.47510873373302426 } },
    usage: USAGE,
  });
  // 整行逐字比对：既能证明保留了 4 位小数，也能证明没有退化成 true/false。
  assert.equal(text.split('\n')[0], 'refund  noul    P(true)=0.4751');
});

test('score：显示 x / (N-1)，概率按档位下标降序', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: {
      urgency: {
        type: 'score',
        score: 1.1542321654504228,
        legend: { 0: 'Routine', 1: 'Soon', 2: 'Immediate' },
        probabilities: { 0: 0.0691, 1: 0.7075, 2: 0.2234 },
        confidence: 0.3043,
      },
    },
    usage: USAGE,
  });
  assert.match(text, /^urgency\s+score\s+1\.1542 \/ 2\s+p=\{1=0\.7075, 2=0\.2234, 0=0\.0691\}\s+conf=0\.304$/m);
});

test('多题：每题一行，名字按最长者对齐', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: {
      a: { type: 'noul', noul: 0.5 },
      longer: { type: 'noul', noul: 0.25 },
    },
    usage: USAGE,
  });
  const lines = text.split('\n');
  assert.equal(lines[0], 'a       noul    P(true)=0.5000');
  assert.equal(lines[1], 'longer  noul    P(true)=0.2500');
});

test('没有 usage 时不渲染 usage 行', () => {
  const text = textOf({ model: 'tev1:0.8b', answers: { q: { type: 'noul', noul: 1 } } });
  assert.equal(text, 'q  noul    P(true)=1.0000');
});

test('未知答案类型不炸，退化为 JSON', () => {
  const text = textOf({ model: 'm', answers: { q: { type: 'mystery', value: 1 } } });
  assert.match(text, /q\s+mystery/);
  assert.match(text, /"value":1/);
});

test('体积口径：value 带 state_bytes/body_bytes 时追加一行', () => {
  const value = {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
    usage: { input_tokens: 799, output_tokens: 1 },
    state_bytes: 101,
    body_bytes: 634,
  };
  const [block] = renderAnswers({}, value);
  assert.match(block.text, /^体积: state=101B body=634B$/m);
});

test('体积告警：body_warning 原样追加；无字段时不得凭空产生告警（即使已超阈值）', () => {
  const warned = renderAnswers({}, {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
    state_bytes: 20000,
    body_bytes: 20480,
    body_warning: '请求体 20480 字节，已超过建议的 16384 字节：可考虑拆成多次调用，或缩小 state。',
  })[0];
  assert.match(warned.text, /^体积: state=20000B body=20480B$/m);
  assert.match(warned.text, /已超过建议的 16384 字节/);

  // 关键：body_bytes **高于**软阈值却**不带** body_warning ⇒ 必须没有任何告警。
  // 若 render 自己内联了 16384 这个阈值，这一条会红 —— 它钉住的正是
  // 「策略属于工具层，render 只呈现」这条 §4.8 约束。
  const plain = renderAnswers({}, {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
    state_bytes: 20000,
    body_bytes: 20480,
  })[0];
  assert.doesNotMatch(plain.text, /超过建议/);
  assert.match(plain.text, /^体积: state=20000B body=20480B$/m);
  // 逐字全文相等：不依赖任何措辞。凡是在 render 里自行判断阈值、自行拼一句告警的
  // 实现，无论它把话怎么说，都会在这里打红 —— 这才是 §4.8 那条约束的承重断言。
  assert.equal(plain.text, 'q  noul    P(true)=0.4751\n体积: state=20000B body=20480B');

  // 任何「在 render 里比较某个有限阈值」的实现都会在这里多打一行 ⇒ 逐字相等打红。
  // 该值远高于 maxBodyBytes(65536)，故连「内联硬上限」那一族变体也一并关掉。
  // render 是纯函数，这个值在单测里完全合法（它不可能来自生产路径，那由 V8 挡住）。
  const huge = renderAnswers({}, {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
    state_bytes: 20000,
    body_bytes: 1e15,
  })[0];
  assert.equal(huge.text, 'q  noul    P(true)=0.4751\n体积: state=20000B body=1000000000000000B');

  // 这条负例的全部意义在于 body_bytes **高于**软阈值；常量一旦被调高越过它，
  // 该用例会静默退化成恒真 —— 这行把那种退化变成红灯。（同理，上面的 1e15 不受影响。）
  assert.ok(20480 > LIMITS.softBodyBytes, '负例 fixture 必须高于 softBodyBytes，否则本条恒真');

  // 空字符串与「没有该键」必须同义：不得打印空行（否则模型会读到一行空白）。
  const empty = renderAnswers({}, {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
    state_bytes: 20000,
    body_bytes: 20480,
    body_warning: '',
  })[0];
  assert.doesNotMatch(empty.text, /\n\s*$/);
  // 直接断言「空串」与「缺键」的输出逐字相同（比拼接期望串更强，也不写死任何列宽）。
  assert.equal(empty.text, plain.text);
});

test('体积口径：字段缺失时不打印该行（向后兼容）', () => {
  const [block] = renderAnswers({}, {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
  });
  assert.doesNotMatch(block.text, /体积:/);
});

// ---------------------------------------------------------------------------
// F1c/F1d（2026-10-04 缺陷审查轮）：OUTPUT_SCHEMA 的 answers 是
// additionalProperties:true，形状残缺的值能通过宿主的无损 JSON 与 schema 两段，
// 最后由 render 兜底 —— 这里抛异常会被宿主包成
// "output.render failed: …"，把一次**成功**调用变成工具失败。
// ---------------------------------------------------------------------------

test('F1c：已知 type 但字段缺失时退化渲染，不得抛异常', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: {
      a: { type: 'choice', choice: 'bug' },
      b: { type: 'noul' },
      c: { type: 'score' },
    },
  });
  // 逐字全文：缺失的数值一律渲染成 —，而不是让 JSON.stringify(undefined) 漏成
  // 字面 undefined，更不是抛 TypeError。
  assert.equal(text, [
    'a  choice  bug  p={—}  conf=—',
    'b  noul    P(true)=—',
    'c  score   — / —  p={—}  conf=—',
  ].join('\n'));
});

test('F1c：概率值不是数值时逐个退化，且不得因排序比较器返回 NaN 而乱序', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: {
      q: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 'oops', c: 0.1 }, confidence: 0.5 },
    },
  });
  assert.equal(text, 'q  choice  a  p={a=0.9000, c=0.1000, b=—}  conf=0.500');
});

test('F1d：answers 为空对象时给出明确占位行，而不是空字符串', () => {
  // 空串等于「模型读到一个没有任何内容的工具结果」，无法与「真的没有答案」区分。
  assert.equal(textOf({ model: 'tev1:0.8b', answers: {} }), '(no answers returned)');
});

// ---------------------------------------------------------------------------
// §4.11（2026-10-06 delta · 置信度门限）：告警与体积告警受**同一条 §4.8 约束** ——
// 门限是策略、住在工具层，render 只原样呈现一行。故这里刻意给一个 confidence 极低的
// 答案：任何「在 render 里比较阈值」的实现都会为此多打一行，逐字相等会打红。
// ---------------------------------------------------------------------------

/** 同一份「置信度极低」的答案，用于对比「带告警键」与「不带」两种输入。 */
const LOW_CONF_VALUE = {
  model: 'tev1:0.8b',
  answers: {
    q: { type: 'choice', choice: 'bug', probabilities: { bug: 0.5, x: 0.5 }, confidence: 0.01 },
  },
};

test('§4.11：无 confidence_warning 键时绝不自行判断置信度（逐字全文）', () => {
  const plain = textOf(LOW_CONF_VALUE);
  assert.doesNotMatch(plain, /confidence 告警/);
  assert.equal(plain, 'q  choice  bug  p={bug=0.5000, x=0.5000}  conf=0.010');
});

test('§4.11：confidence_warning 原样追加为最后一行；空串与缺键同义', () => {
  const plain = textOf(LOW_CONF_VALUE);
  const warned = textOf({ ...LOW_CONF_VALUE, confidence_warning: 'confidence 告警：以下 1 题……' });
  // 逐字：既证明它原样打印（render 不改写措辞），也证明它与体积行无关地独立出现。
  assert.equal(warned, `${plain}\nconfidence 告警：以下 1 题……`);
  // 空串必须与缺键逐字相同 —— 否则模型会读到一行空白。
  assert.equal(textOf({ ...LOW_CONF_VALUE, confidence_warning: '' }), plain);
});

test('§4.11：告警行排在体积口径与体积告警之后（模型读到的是最后一行）', () => {
  assert.equal(textOf({
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4 } },
    state_bytes: 20000,
    body_bytes: 20480,
    body_warning: '体积告警行',
    confidence_warning: '置信度告警行',
  }), 'q  noul    P(true)=0.4000\n体积: state=20000B body=20480B\n体积告警行\n置信度告警行');
});
