export const CODEX_SLASH_COMMANDS = [
  { id: 'help', label: 'Help', command: '/help', description: 'Show Codex slash commands' },
  { id: 'status', label: 'Status', command: '/status', description: 'Show Codex session status' },
  { id: 'review', label: 'Review', command: '/review', description: 'Ask Codex to review the current changes' },
  { id: 'compact', label: 'Compact', command: '/compact', description: 'Ask Codex to compact context' },
];

export function isSlashPaletteRequest(text) {
  const value = String(text ?? '').trim().toLowerCase();
  return value === 'slash' || value === '/slash' || value === '/commands';
}

export function slashCommandById(id) {
  return CODEX_SLASH_COMMANDS.find((command) => command.id === id) ?? null;
}

export function slashCommandKeyboard() {
  return [
    CODEX_SLASH_COMMANDS.slice(0, 2),
    CODEX_SLASH_COMMANDS.slice(2, 4),
  ].map((row) => row.map((command) => ({
    text: command.label,
    callback_data: `cmd:${command.id}`,
  })));
}

export function slashCommandMessage() {
  return [
    'Codex slash commands',
    '',
    ...CODEX_SLASH_COMMANDS.map((command) => `${command.command} - ${command.description}`),
  ].join('\n');
}
