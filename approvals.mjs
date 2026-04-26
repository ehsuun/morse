export function approvalMessage(method, params = {}) {
  if (method === 'item/commandExecution/requestApproval') return commandApprovalMessage(params);
  if (method === 'execCommandApproval') return legacyCommandApprovalMessage(params);
  if (method === 'item/fileChange/requestApproval') return fileChangeApprovalMessage(params);
  if (method === 'applyPatchApproval') return legacyPatchApprovalMessage(params);
  if (method === 'item/permissions/requestApproval') return permissionsApprovalMessage(params);
  return [
    'Codex needs approval',
    '',
    method,
    params.reason ? `reason: ${params.reason}` : '',
  ].filter(Boolean).join('\n');
}

export function approvalKeyboard(method) {
  if (method === 'item/permissions/requestApproval') {
    return [
      [
        { text: 'Allow once', callback_data: 'allow' },
        { text: 'Allow session', callback_data: 'allow_session' },
      ],
      [
        { text: 'Deny', callback_data: 'deny' },
      ],
    ];
  }

  return [
    [
      { text: 'Approve', callback_data: 'accept' },
      { text: 'Approve session', callback_data: 'accept_session' },
    ],
    [
      { text: 'Deny', callback_data: 'decline' },
      { text: 'Abort', callback_data: 'cancel' },
    ],
  ];
}

export function approvalResponse(method, params = {}, action) {
  if (method === 'item/commandExecution/requestApproval') {
    return { decision: commandDecision(action) };
  }
  if (method === 'item/fileChange/requestApproval') {
    return { decision: fileChangeDecision(action) };
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return { decision: legacyDecision(action) };
  }
  if (method === 'item/permissions/requestApproval') {
    return permissionsDecision(params, action);
  }
  return action === 'accept' || action === 'accept_session' || action === 'allow' || action === 'allow_session'
    ? { decision: 'accept' }
    : { decision: 'decline' };
}

export function approvalActionLabel(action) {
  return {
    accept: 'approved',
    accept_session: 'approved for session',
    allow: 'allowed',
    allow_session: 'allowed for session',
    decline: 'denied',
    deny: 'denied',
    cancel: 'aborted',
  }[action] ?? action;
}

function commandApprovalMessage(params) {
  return [
    'Codex wants to run a command',
    '',
    params.command ? fenced(params.command) : '(command not provided)',
    params.cwd ? `cwd: ${params.cwd}` : '',
    params.reason ? `reason: ${params.reason}` : '',
    networkLine(params),
    amendmentLine(params),
  ].filter(Boolean).join('\n');
}

function legacyCommandApprovalMessage(params) {
  return [
    'Codex wants to run a command',
    '',
    Array.isArray(params.command) ? fenced(params.command.join(' ')) : '(command not provided)',
    params.cwd ? `cwd: ${params.cwd}` : '',
    params.reason ? `reason: ${params.reason}` : '',
  ].filter(Boolean).join('\n');
}

function fileChangeApprovalMessage(params) {
  return [
    'Codex wants to change files',
    '',
    params.grantRoot ? `root: ${params.grantRoot}` : '',
    params.reason ? `reason: ${params.reason}` : '',
  ].filter(Boolean).join('\n');
}

function legacyPatchApprovalMessage(params) {
  const files = Object.keys(params.fileChanges ?? {});
  return [
    'Codex wants to apply a patch',
    '',
    files.length ? `files:\n${files.map((file) => `- ${file}`).join('\n')}` : '',
    params.grantRoot ? `root: ${params.grantRoot}` : '',
    params.reason ? `reason: ${params.reason}` : '',
  ].filter(Boolean).join('\n');
}

function permissionsApprovalMessage(params) {
  return [
    'Codex wants extra permissions',
    '',
    params.cwd ? `cwd: ${params.cwd}` : '',
    params.reason ? `reason: ${params.reason}` : '',
    formatPermissions(params.permissions),
  ].filter(Boolean).join('\n');
}

function commandDecision(action) {
  if (action === 'accept_session') return 'acceptForSession';
  if (action === 'cancel') return 'cancel';
  if (action === 'decline' || action === 'deny') return 'decline';
  return 'accept';
}

function fileChangeDecision(action) {
  if (action === 'accept_session') return 'acceptForSession';
  if (action === 'cancel') return 'cancel';
  if (action === 'decline' || action === 'deny') return 'decline';
  return 'accept';
}

function legacyDecision(action) {
  if (action === 'accept_session') return 'approved_for_session';
  if (action === 'cancel') return 'abort';
  if (action === 'decline' || action === 'deny') return 'denied';
  return 'approved';
}

function permissionsDecision(params, action) {
  if (action === 'allow' || action === 'allow_session' || action === 'accept' || action === 'accept_session') {
    return {
      permissions: params.permissions ?? {},
      scope: action.endsWith('_session') ? 'session' : 'turn',
    };
  }
  return {
    permissions: {},
    scope: 'turn',
  };
}

function networkLine(params) {
  const host = params.networkApprovalContext?.host;
  const protocol = params.networkApprovalContext?.protocol;
  return host ? `network: ${protocol ?? 'network'}://${host}` : '';
}

function amendmentLine(params) {
  if (params.proposedExecpolicyAmendment?.length) return `can remember: ${params.proposedExecpolicyAmendment.join(' ')}`;
  if (params.proposedNetworkPolicyAmendments?.length) {
    return `network policy: ${params.proposedNetworkPolicyAmendments.map((rule) => `${rule.action} ${rule.host}`).join(', ')}`;
  }
  return '';
}

function formatPermissions(permissions = {}) {
  const lines = [];
  if (permissions.network?.enabled !== undefined && permissions.network?.enabled !== null) {
    lines.push(`network: ${permissions.network.enabled ? 'enabled' : 'disabled'}`);
  }
  const fs = permissions.fileSystem;
  if (fs?.read?.length) lines.push(`read: ${fs.read.join(', ')}`);
  if (fs?.write?.length) lines.push(`write: ${fs.write.join(', ')}`);
  if (fs?.entries?.length) lines.push(`filesystem entries: ${fs.entries.length}`);
  return lines.join('\n');
}

function fenced(text) {
  return ['```', String(text), '```'].join('\n');
}
