export const CODEX_SLASH_COMMANDS = [
  { id: 'help', label: 'Help', command: '/help', description: 'Show Codex slash commands' },
  { id: 'model', label: 'Model', command: '/model', description: 'Pick the active model', submenu: 'model' },
  { id: 'status', label: 'Status', command: '/status', description: 'Show Codex session status' },
  { id: 'review', label: 'Review', command: '/review', description: 'Ask Codex to review the current changes' },
  { id: 'compact', label: 'Compact', command: '/compact', description: 'Ask Codex to compact context' },
];

export const CODEX_MODEL_CHOICES = [
  { id: 'gpt-5.5', label: 'GPT-5.5', command: '/model gpt-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4', command: '/model gpt-5.4' },
  { id: 'gpt-5.4-mini', label: '5.4 Mini', command: '/model gpt-5.4-mini' },
  { id: 'gpt-5.3-codex', label: 'Codex', command: '/model gpt-5.3-codex' },
];

export function isSlashPaletteRequest(text) {
  const value = String(text ?? '').trim().toLowerCase();
  return value === 'slash' || value === '/slash' || value === '/commands';
}

export function slashCommandById(id) {
  return CODEX_SLASH_COMMANDS.find((command) => command.id === id) ?? null;
}

export function modelChoiceById(id) {
  return CODEX_MODEL_CHOICES.find((model) => model.id === id) ?? null;
}

export function slashCommandKeyboard() {
  return chunk(CODEX_SLASH_COMMANDS, 2).map((row) => row.map((command) => ({
    text: command.label,
    callback_data: `cmd:${command.id}`,
  })));
}

export function modelChoiceKeyboard() {
  return [
    ...chunk(CODEX_MODEL_CHOICES, 2).map((row) => row.map((model) => ({
      text: model.label,
      callback_data: `model:${model.id}`,
    }))),
    [{ text: 'Back', callback_data: 'cmd:back' }],
  ];
}

export function modelChoiceMessage() {
  return 'Choose a Codex model';
}

export function slashCommandMessage() {
  return [
    'Codex slash commands',
    '',
    ...CODEX_SLASH_COMMANDS.map((command) => `${command.command} - ${command.description}`),
  ].join('\n');
}

function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}
