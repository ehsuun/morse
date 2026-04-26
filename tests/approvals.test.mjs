import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalKeyboard, approvalMessage, approvalResponse } from '../approvals.mjs';

test('approvalResponse maps command approval buttons to app-server decisions', () => {
  assert.deepEqual(approvalResponse('item/commandExecution/requestApproval', {}, 'accept'), { decision: 'accept' });
  assert.deepEqual(approvalResponse('item/commandExecution/requestApproval', {}, 'accept_session'), { decision: 'acceptForSession' });
  assert.deepEqual(approvalResponse('item/commandExecution/requestApproval', {}, 'decline'), { decision: 'decline' });
  assert.deepEqual(approvalResponse('item/commandExecution/requestApproval', {}, 'cancel'), { decision: 'cancel' });
});

test('approvalResponse maps file approval buttons to app-server decisions', () => {
  assert.deepEqual(approvalResponse('item/fileChange/requestApproval', {}, 'accept_session'), { decision: 'acceptForSession' });
  assert.deepEqual(approvalResponse('item/fileChange/requestApproval', {}, 'decline'), { decision: 'decline' });
});

test('approvalResponse maps legacy command approval buttons', () => {
  assert.deepEqual(approvalResponse('execCommandApproval', {}, 'accept'), { decision: 'approved' });
  assert.deepEqual(approvalResponse('execCommandApproval', {}, 'accept_session'), { decision: 'approved_for_session' });
  assert.deepEqual(approvalResponse('execCommandApproval', {}, 'decline'), { decision: 'denied' });
  assert.deepEqual(approvalResponse('execCommandApproval', {}, 'cancel'), { decision: 'abort' });
});

test('approvalResponse grants requested permissions for turn or session', () => {
  const params = { permissions: { network: { enabled: true } } };
  assert.deepEqual(approvalResponse('item/permissions/requestApproval', params, 'allow'), {
    permissions: { network: { enabled: true } },
    scope: 'turn',
  });
  assert.deepEqual(approvalResponse('item/permissions/requestApproval', params, 'allow_session'), {
    permissions: { network: { enabled: true } },
    scope: 'session',
  });
  assert.deepEqual(approvalResponse('item/permissions/requestApproval', params, 'deny'), {
    permissions: {},
    scope: 'turn',
  });
});

test('approvalKeyboard returns inline actions', () => {
  assert.deepEqual(approvalKeyboard('item/commandExecution/requestApproval')[0].map((button) => button.callback_data), [
    'accept',
    'accept_session',
  ]);
  assert.deepEqual(approvalKeyboard('item/permissions/requestApproval')[0].map((button) => button.callback_data), [
    'allow',
    'allow_session',
  ]);
});

test('approvalMessage formats command requests', () => {
  const message = approvalMessage('item/commandExecution/requestApproval', {
    command: 'npm test',
    cwd: 'J:\\Projects\\morse',
    reason: 'verify changes',
  });
  assert.match(message, /Codex wants to run a command/);
  assert.match(message, /npm test/);
  assert.match(message, /verify changes/);
});
