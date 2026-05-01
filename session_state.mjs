import { loadSessionsState, saveSessionsState } from './config.mjs';

const EMPTY_STATE = Object.freeze({ sessions: [], chats: {} });

export function normalizeSessionsState(state) {
  if (!state || typeof state !== 'object') return { sessions: [], chats: {} };
  return {
    sessions: Array.isArray(state.sessions) ? state.sessions.filter((session) => session?.id) : [],
    chats: state.chats && typeof state.chats === 'object' && !Array.isArray(state.chats) ? state.chats : {},
  };
}

export function loadSessionRegistry() {
  return normalizeSessionsState(loadSessionsState() ?? EMPTY_STATE);
}

export function saveSessionRegistry(registry) {
  return saveSessionsState(normalizeSessionsState(registry));
}

export function upsertSession(session, now = new Date().toISOString()) {
  if (!session?.id) throw new Error('session id is required');
  const registry = loadSessionRegistry();
  const index = registry.sessions.findIndex((item) => item.id === session.id);
  const existing = index >= 0 ? registry.sessions[index] : {};
  const next = {
    ...existing,
    ...session,
    updatedAt: session.updatedAt ?? now,
  };
  if (index >= 0) {
    registry.sessions[index] = next;
  } else {
    registry.sessions.push(next);
  }
  saveSessionRegistry(registry);
  return next;
}

export function removeSession(sessionId) {
  const registry = loadSessionRegistry();
  const nextSessions = registry.sessions.filter((session) => session.id !== sessionId);
  let changed = nextSessions.length !== registry.sessions.length;
  registry.sessions = nextSessions;
  for (const [chatId, chat] of Object.entries(registry.chats)) {
    if (chat?.activeSessionId === sessionId) {
      delete registry.chats[chatId];
      changed = true;
    }
  }
  if (changed) saveSessionRegistry(registry);
}

export function pruneSessions(predicate) {
  const registry = loadSessionRegistry();
  const nextSessions = registry.sessions.filter(predicate);
  const liveIds = new Set(nextSessions.map((session) => session.id));
  let changed = nextSessions.length !== registry.sessions.length;
  registry.sessions = nextSessions;
  for (const [chatId, chat] of Object.entries(registry.chats)) {
    if (chat?.activeSessionId && !liveIds.has(chat.activeSessionId)) {
      delete registry.chats[chatId];
      changed = true;
    }
  }
  if (changed) saveSessionRegistry(registry);
  return registry;
}

export function pruneDeadSessions(isProcessAlive) {
  const registry = loadSessionRegistry();
  const dead = registry.sessions.filter((session) => session.pid && !isProcessAlive(session.pid));
  if (!dead.length) return { registry, removed: [] };
  const deadIds = new Set(dead.map((session) => session.id));
  return {
    registry: pruneSessions((session) => !deadIds.has(session.id)),
    removed: dead,
  };
}

export function sessionsByRecent(registry = loadSessionRegistry()) {
  return [...normalizeSessionsState(registry).sessions].sort((a, b) => {
    const aTime = Date.parse(a.activeThreadUpdatedAt ?? a.updatedAt ?? a.startedAt ?? '') || 0;
    const bTime = Date.parse(b.activeThreadUpdatedAt ?? b.updatedAt ?? b.startedAt ?? '') || 0;
    return bTime - aTime;
  });
}

export function setChatActiveSession(chatId, sessionId, now = new Date().toISOString()) {
  const registry = loadSessionRegistry();
  if (!registry.sessions.some((session) => session.id === sessionId)) return null;
  registry.chats[String(chatId)] = { activeSessionId: sessionId, updatedAt: now };
  saveSessionRegistry(registry);
  return sessionById(sessionId, registry);
}

export function activeSessionForChat(chatId, registry = loadSessionRegistry()) {
  const normalized = normalizeSessionsState(registry);
  const activeId = normalized.chats[String(chatId)]?.activeSessionId;
  const explicit = activeId ? sessionById(activeId, normalized) : null;
  return explicit ?? sessionsByRecent(normalized)[0] ?? null;
}

export function sessionById(sessionId, registry = loadSessionRegistry()) {
  return normalizeSessionsState(registry).sessions.find((session) => session.id === sessionId) ?? null;
}
