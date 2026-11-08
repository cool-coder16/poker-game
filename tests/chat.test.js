// tests/chat.test.js — run with:  node tests/chat.test.js
const assert = require('assert');
const { load } = require('./helpers');
load('chat.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
console.log('chat tests');

test('cleanChatText trims, collapses spaces, removes control characters and caps the length', () => {
  assert.strictEqual(cleanChatText('  hello   there \n friend\t!'), 'hello there friend !');
  assert.strictEqual(cleanChatText('a\u0000b\u0007c'), 'a b c');
  assert.strictEqual(cleanChatText('   '), '');
  assert.strictEqual(cleanChatText(null), '');
  assert.strictEqual(cleanChatText(undefined), '');
  assert.strictEqual(cleanChatText('x'.repeat(500)).length, CHAT_MAX_LENGTH);
  assert.strictEqual(cleanChatText('<b>bold</b>'), '<b>bold</b>', 'markup is kept as plain text (the page never uses innerHTML for chat)');
});

test('the page waits 2 seconds between messages (a little more than the 1.5 the rules require)', () => {
  assert.strictEqual(chatCooldownLeft(1000, 1000), 2000);
  assert.strictEqual(chatCooldownLeft(1000, 2000), 1000);
  assert.strictEqual(chatCooldownLeft(1000, 3000), 0);
  assert(CHAT_COOLDOWN_MS > 1500, 'longer than the server rule');
  assert.strictEqual(chatCooldownLeft(0, 5000), 0, 'never sent: no wait');
});

test('chat can be off for the room, or the host can mute you', () => {
  assert.deepStrictEqual(chatAllowed({}, {}, 'me'), { ok: true });
  assert.deepStrictEqual(chatAllowed({ chat: true }, null, 'me'), { ok: true });
  assert.strictEqual(chatAllowed({ chat: false }, {}, 'me').ok, false);
  assert.strictEqual(chatAllowed({}, { me: true }, 'me').ok, false);
  assert.strictEqual(chatAllowed({}, { someoneElse: true }, 'me').ok, true);
});

test('blocked people are hidden from you only', () => {
  const msgs = [{ uid: 'a', text: '1' }, { uid: 'b', text: '2' }, { uid: 'a', text: '3' }];
  assert.deepStrictEqual(chatVisible(msgs, ['a']).map(m => m.text), ['2']);
  assert.strictEqual(chatVisible(msgs, []).length, 3);
  assert.deepStrictEqual(chatVisible(null, ['a']), []);
});

test('the block list survives storage that is missing or broken', () => {
  assert.deepStrictEqual(loadBlocked(), [], 'no localStorage in Node: empty list, no crash');
  saveBlocked(['x']);   // must not throw
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
