// Pure library view model: installed games, newest local save and labels.

import { saveProfileLabel } from '../save-profiles.mjs';
import { latestRecordByGame } from './save-records.mjs';

export function formatRelativeTime(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const deltaSeconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (deltaSeconds < 60) return 'just now';
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return 'yesterday';
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatPlayTime(totalMinutes) {
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0) return '';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.floor(totalMinutes % 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function locationLabel(summary, mapNames = null) {
  if (!summary?.map) return '';
  const key = `${summary.map.group}:${summary.map.num}`;
  return mapNames?.[key] ?? `Map ${key}`;
}

export function buildLibraryModel({
  games = [],
  records = [],
  summaries = {},
  mapNames = {},
  now = Date.now(),
} = {}) {
  // Continue always means ordinary game progress. Dedicated rules-mode slots
  // (for example SoulLink's soulrun) must never become a Standard save.
  const latest = latestRecordByGame(records.filter((record) => record.slot === 'main'));
  const entries = games
    .filter((game) => !game.hidden)
    .map((game) => {
      const record = latest.get(game.id) ?? null;
      const summary = record ? summaries[record.key] ?? null : null;
      return {
        ...game,
        record,
        summary,
        hasSave: Boolean(record && summary?.valid),
        saveName: record ? saveProfileLabel(record.profile) : '',
        lastPlayedAt: record?.updatedAt ?? 0,
        lastPlayedLabel: formatRelativeTime(record?.updatedAt, now),
        location: locationLabel(summary?.player, mapNames[game.id]),
        playTime: formatPlayTime(summary?.player?.playTimeTotalMinutes),
        actionLabel: record && summary?.valid ? 'Continue' : 'Play',
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  return {
    games: entries,
    hero: entries.reduce((latestEntry, entry) => (
      !latestEntry || entry.lastPlayedAt > latestEntry.lastPlayedAt ? entry : latestEntry
    ), null),
  };
}
