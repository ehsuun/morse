import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_SLASH_COMMANDS,
  CODEX_MODEL_CHOICES,
  isSlashPaletteRequest,
  modelChoiceById,
  modelChoiceKeyboard,
  modelChoiceMessage,
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

test('modelChoiceById returns configured model commands', () => {
  assert.equal(modelChoiceById('gpt-5.4').command, '/model gpt-5.4');
  assert.equal(modelChoiceById('missing'), null);
});

test('slashCommandKeyboard uses compact callback ids', () => {
  const ids = slashCommandKeyboard().flat().map((button) => button.callback_data);
  assert.deepEqual(ids, CODEX_SLASH_COMMANDS.map((command) => `cmd:${command.id}`));
});

test('modelChoiceKeyboard shows model choices and a back button', () => {
  const ids = modelChoiceKeyboard().flat().map((button) => button.callback_data);
  assert.deepEqual(ids, [
    ...CODEX_MODEL_CHOICES.map((model) => `model:${model.id}`),
    'cmd:back',
  ]);
});

test('slashCommandMessage lists available commands', () => {
  const message = slashCommandMessage();
  assert.match(message, /Codex slash commands/);
  assert.match(message, /\/model/);
  assert.match(message, /\/review/);
  assert.match(message, /\/compact/);
});

test('modelChoiceMessage labels the model picker', () => {
  assert.match(modelChoiceMessage(), /model/i);
});
