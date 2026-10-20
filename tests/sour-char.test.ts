// 「酸」不寫「痠」（Karen 2026-10-20 定案）的單元測試。
// sour-char.ts 沒有副作用可以直接 import；seo-video.ts／viral-learner.ts 一 import 就連資料庫，
// 所以那邊只讀原始碼檢查接線（同 episode-number.test.ts 的做法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixSourChar } from '../src/services/sour-char.js';

test('痠一律換成酸', () => {
  assert.equal(fixSourChar('唱完喉嚨痠、腰痠背痛、肌肉痠軟'), '唱完喉嚨酸、腰酸背痛、肌肉酸軟');
  assert.equal(fixSourChar('{"hook":"痠痛"}'), '{"hook":"酸痛"}');
});

test('沒有痠的字原封不動', () => {
  assert.equal(fixSourChar('喉嚨酸痛怎麼辦'), '喉嚨酸痛怎麼辦');
  assert.equal(fixSourChar(''), '');
});

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const RULE = '身體痠痛一律寫『酸』（酸痛、喉嚨酸），不寫『痠』。';

test('所有 AI 文字都經過 callLuna 的安全網', () => {
  assert.match(src('src/services/seo-video.ts'), /return fixSourChar\(text\);/);
});

test('爆款學習的輸出也換字', () => {
  assert.match(src('src/services/viral-learner.ts'), /const cleaned = fixSourChar\(text\)/);
});

test('文案、標題的提示詞都有這條規則', () => {
  const s = src('src/services/seo-video.ts');
  assert.equal(s.split(RULE).length - 1, 2);
});

test('逐字稿轉繁體後立刻換字', () => {
  assert.match(src('scripts/transcribe.py'), /OpenCC\("s2twp"\)\.convert\(text\)\.replace\("痠", "酸"\)/);
});
