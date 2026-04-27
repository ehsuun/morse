import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_SLASH_COMMANDS,
  isSlashPaletteRequest,
  slashCommandById,
  slashCommandKeyboard,
  slashCommandMessage,
} from '../slash_commands.mjs';

test('isSlashPaletteRequest accepts slash palette triggers', () => {
  assert.equal(isSlashPaletteRequest('slash'), true);
  assert.equal(isSlashPaletteRequest('/slash'), true);
  assert.equal(isSlashPaletteRequest('/commands'), true);
  assert.equal(isSlashPaletteRequest('/review'), false);
});

test('slashCommandById returns configured commands', () => {
  assert.equal(slashCommandById('review').command, '/review');
  assert.equal(slashCommandById('missing'), null);
});

test('slashCommandKeyboard uses compact callback ids', () => {
  const ids = slashCommandKeyboard().flat().map((button) => button.callback_data);
  assert.deepEqual(ids, CODEX_SLASH_COMMANDS.map((command) => `cmd:${command.id}`));
});

test('slashCommandMessage lists available commands', () => {
  const message = slashCommandMessage();
  assert.match(message, /Codex slash commands/);
  assert.match(message, /\/review/);
  assert.match(message, /\/compact/);
});
