import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeTelegramPeer } from '../telegram_auth.mjs';

const runtime = {
  allowedUserIds: [42],
  allowedChatIds: [123],
};

test('authorizeTelegramPeer allows the configured private chat', () => {
  assert.deepEqual(
    authorizeTelegramPeer(runtime, { userId: 42, chatId: 123, chatType: 'private' }),
    { ok: true },
  );
});

test('authorizeTelegramPeer rejects groups even for an allowed user', () => {
  const result = authorizeTelegramPeer(runtime, { userId: 42, chatId: -100, chatType: 'supergroup' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /private chat/);
});

test('authorizeTelegramPeer rejects other private chats when chat ids are bound', () => {
  const result = authorizeTelegramPeer(runtime, { userId: 42, chatId: 999, chatType: 'private' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unauthorized chat/);
});

test('authorizeTelegramPeer still requires private chats for legacy configs without chat ids', () => {
  const result = authorizeTelegramPeer({ allowedUserIds: [42] }, { userId: 42, chatId: -100, chatType: 'group' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /private chat/);
});
