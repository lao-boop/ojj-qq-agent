import { isOwner } from './global.js';

export function allowedPrivate(qq, cfg) {
  const access = cfg.access || {};
  if (access.mode === 'open' || isOwner(qq, cfg)) return true;
  if ((access.privateAllow || []).some(id => String(id) === String(qq))) return true;
  const empty = !access.adminQQ?.length && !access.privateAllow?.length && !access.groupAllow?.length;
  return Boolean(access.allowAllWhenEmpty && empty);
}

export function allowedGroup(groupId, cfg) {
  const access = cfg.access || {};
  if (access.mode === 'open') return true;
  if ((access.groupAllow || []).some(id => String(id) === String(groupId))) return true;
  const empty = !access.adminQQ?.length && !access.privateAllow?.length && !access.groupAllow?.length;
  return Boolean(access.allowAllWhenEmpty && empty);
}
