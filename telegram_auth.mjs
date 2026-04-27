export function authorizeTelegramPeer(runtime, { userId, chatId, chatType }) {
  const allowedUserIds = normalizeIds(runtime?.allowedUserIds);
  const allowedChatIds = normalizeIds(runtime?.allowedChatIds);
  const numericUserId = Number(userId);
  const numericChatId = Number(chatId);

  if (!allowedUserIds.includes(numericUserId)) {
    return { ok: false, reason: `unauthorized user ${userId ?? '(unknown)'}` };
  }

  if (chatType !== 'private') {
    return { ok: false, reason: 'private chat required' };
  }

  if (allowedChatIds.length > 0 && !allowedChatIds.includes(numericChatId)) {
    return { ok: false, reason: `unauthorized chat ${chatId ?? '(unknown)'}` };
  }

  return { ok: true };
}

function normalizeIds(ids) {
  return (ids ?? []).map(Number).filter(Number.isFinite);
}
