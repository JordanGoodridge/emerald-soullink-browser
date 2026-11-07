// DOM renderer for the party panel.
//
// Takes the DOM-free model from presence/party-panel-model.mjs and fills a
// container. Kept separate from app.js so it can be previewed and tested with
// fakes; it never reads engine, network or storage state.

import { awayLabel } from '../presence/member-status.mjs';

export const PARTY_AVAILABILITY_LABEL = Object.freeze({
  hidden: 'Not sharing their party',
  unavailable: 'No party data',
  stale: 'Party is out of date',
});

const RUN_STATUS_LABEL = Object.freeze({
  active: 'Active run',
  wipe_pending: 'Group wipe',
  waiting: 'Waiting for players',
  completed: 'Completed',
});

const LINK_PLACEMENT_LABEL = Object.freeze({
  party: 'In party',
  boxed: 'Boxed',
  dead: 'Fallen',
});

function formatInlinePartnerLabel(link) {
  const partners = Array.isArray(link?.partners) ? link.partners : [];
  if (!partners.length) return '⛓ SoulLink bond';
  const summary = partners
    .map((partner) => `${partner.name}’s ${partner.label}`)
    .join(' + ');
  return `⛓ ${summary}`;
}

function createStatPill(doc, value, label, tone = 'default') {
  const pill = doc.createElement('span');
  pill.className = 'party-stat-pill';
  pill.dataset.tone = tone;
  const num = doc.createElement('strong');
  num.textContent = String(value);
  const text = doc.createElement('span');
  text.textContent = label;
  pill.append(num, text);
  return pill;
}

function renderPlayerCard(doc, player, { moveRelearnerEnabled, onOpenMoveRelearner }) {
  const section = doc.createElement('section');
  section.className = 'party-player';
  section.classList.toggle('is-self', Boolean(player.isSelf));
  section.classList.toggle('stale', Boolean(player.stale) && !player.isSelf);
  section.dataset.playerId = player.playerId;

  const head = doc.createElement('header');
  head.className = 'party-player-head';

  const heading = doc.createElement('h3');
  heading.textContent = player.isSelf ? `${player.name} (you)` : player.name;
  head.append(heading);

  const badges = doc.createElement('div');
  badges.className = 'party-player-badges';

  if (player.isSelf) {
    const selfBadge = doc.createElement('span');
    selfBadge.className = 'party-badge party-badge-self';
    selfBadge.textContent = 'You';
    badges.append(selfBadge);
  } else if (player.stale) {
    const away = doc.createElement('span');
    away.className = 'party-badge party-player-away';
    away.textContent = awayLabel(player.mapName);
    badges.append(away);
  } else if (player.mapName) {
    const loc = doc.createElement('span');
    loc.className = 'party-badge party-badge-location';
    loc.textContent = player.mapName;
    badges.append(loc);
  }

  if (player.availability === 'available') {
    const count = doc.createElement('span');
    count.className = 'party-count-badge';
    count.textContent = `${player.members.length}/6`;
    badges.append(count);
  }

  head.append(badges);
  section.append(head);

  if (player.availability !== 'available') {
    const note = doc.createElement('p');
    note.className = 'party-player-state';
    note.textContent = PARTY_AVAILABILITY_LABEL[player.availability] ?? 'No party data';
    section.append(note);
    return section;
  }
  if (!player.members.length) {
    const note = doc.createElement('p');
    note.className = 'party-player-state';
    note.textContent = 'No Pokémon yet.';
    section.append(note);
    return section;
  }

  const list = doc.createElement('ul');
  list.className = 'party-list';
  for (const [partyIndex, member] of player.members.entries()) {
    const item = doc.createElement('li');
    item.className = 'party-slot';
    item.dataset.species = String(member.species);
    if (member.link) {
      item.dataset.linked = 'true';
    }

    const topRow = doc.createElement('div');
    topRow.className = 'party-slot-top';

    const slotIndex = doc.createElement('span');
    slotIndex.className = 'party-slot-index';
    slotIndex.textContent = `#${partyIndex + 1}`;

    const identity = doc.createElement('div');
    identity.className = 'party-slot-identity';

    const name = doc.createElement('strong');
    name.className = 'party-slot-name';
    name.textContent = member.nickname || member.speciesName || `#${member.species}`;
    identity.append(name);

    if (member.nickname && member.speciesName && member.nickname !== member.speciesName) {
      const speciesSub = doc.createElement('small');
      speciesSub.className = 'party-slot-species';
      speciesSub.textContent = member.speciesName;
      identity.append(speciesSub);
    }

    const meta = doc.createElement('span');
    meta.className = 'party-slot-meta';
    const parts = [];
    if (member.level !== null) parts.push(`Lv ${member.level}`);
    if (member.hp !== null) parts.push(`HP ${member.hp}`);
    meta.textContent = parts.join(' · ');

    topRow.append(slotIndex, identity, meta);

    if (player.isSelf && moveRelearnerEnabled && typeof onOpenMoveRelearner === 'function') {
      const relearn = doc.createElement('button');
      relearn.type = 'button';
      relearn.className = 'party-slot-relearn';
      relearn.textContent = 'Moves';
      relearn.setAttribute('aria-label', `Relearn moves for ${name.textContent}`);
      relearn.addEventListener('click', () => onOpenMoveRelearner(partyIndex));
      topRow.append(relearn);
    }

    item.append(topRow);

    if (member.link) {
      const linkTag = doc.createElement('div');
      linkTag.className = 'party-slot-link';
      linkTag.dataset.status = member.link.status ?? 'active';

      const partnerSpan = doc.createElement('span');
      partnerSpan.className = 'party-slot-link-partner';
      partnerSpan.textContent = formatInlinePartnerLabel(member.link);
      linkTag.append(partnerSpan);

      if (member.link.areaLabel) {
        const areaSpan = doc.createElement('span');
        areaSpan.className = 'party-slot-link-area';
        areaSpan.textContent = member.link.areaLabel;
        linkTag.append(areaSpan);
      }

      item.append(linkTag);
    }

    list.append(item);
  }
  section.append(list);
  return section;
}

function renderLinksSection(doc, links) {
  const linksSection = doc.createElement('details');
  linksSection.className = 'party-links';
  linksSection.open = true;
  linksSection.setAttribute?.('open', '');

  const head = doc.createElement('summary');
  head.className = 'party-section-head party-collapsible-summary';
  const h = doc.createElement('h3');
  h.textContent = 'SoulLink bonds';
  const count = doc.createElement('span');
  count.className = 'party-count-badge';
  count.textContent = `${links.length}`;
  head.append(h, count);
  linksSection.append(head);

  const list = doc.createElement('ul');
  list.className = 'party-link-list';
  for (const link of links) {
    const placement = link.placement ?? (link.status === 'dead' ? 'dead' : 'party');
    const item = doc.createElement('li');
    item.className = 'party-link';
    item.dataset.status = link.status;
    item.dataset.placement = placement;

    const rowHead = doc.createElement('div');
    rowHead.className = 'party-link-head';

    const origin = doc.createElement('span');
    origin.className = 'party-link-origin';
    origin.textContent = link.areaLabel || 'SoulLink bond';

    const pairsRow = doc.createElement('div');
    pairsRow.className = 'party-link-pairs';
    for (const [idx, pair] of link.pairs.entries()) {
      if (idx > 0) {
        const arrow = doc.createElement('span');
        arrow.className = 'party-link-arrow';
        arrow.setAttribute?.('aria-hidden', 'true');
        arrow.textContent = '↔';
        pairsRow.append(arrow);
      }
      const chip = doc.createElement('span');
      chip.className = 'party-link-chip';

      const owner = doc.createElement('span');
      owner.className = 'party-link-owner';
      owner.textContent = `${pair.name}’s`;

      const mon = doc.createElement('strong');
      mon.className = 'party-link-mon';
      mon.textContent = pair.nickname || pair.speciesName || (pair.species ? `#${pair.species}` : 'Unknown');

      chip.append(owner, mon);

      if (pair.level !== null && pair.level !== undefined) {
        const lv = doc.createElement('small');
        lv.className = 'party-link-lv';
        lv.textContent = `Lv ${pair.level}`;
        chip.append(lv);
      }

      pairsRow.append(chip);
    }

    const badge = doc.createElement('span');
    badge.className = 'party-link-badge';
    badge.dataset.placement = placement;
    badge.textContent = LINK_PLACEMENT_LABEL[placement] ?? 'Linked';

    rowHead.append(origin, pairsRow, badge);
    item.append(rowHead);
    list.append(item);
  }
  linksSection.append(list);
  return linksSection;
}

function renderRunSummarySection(doc, tracker, links, { onOpenRunTracker }) {
  const runSection = doc.createElement('section');
  runSection.className = 'party-run-tracker party-run-summary';

  const head = doc.createElement('header');
  head.className = 'party-section-head';

  const titleWrap = doc.createElement('div');
  titleWrap.className = 'party-section-title-group';

  const heading = doc.createElement('h3');
  heading.textContent = tracker.status === 'wipe_pending' ? 'Group wipe' : 'Run overview';

  const statusPill = doc.createElement('span');
  statusPill.className = 'party-status-pill';
  statusPill.dataset.status = tracker.status;
  statusPill.textContent = RUN_STATUS_LABEL[tracker.status] ?? tracker.status;

  titleWrap.append(heading, statusPill);
  head.append(titleWrap);

  const counts = tracker.summary ?? {};
  const graveyard = tracker.graveyard ?? [];
  const pillsBar = doc.createElement('div');
  pillsBar.className = 'party-stat-pills';
  pillsBar.append(
    createStatPill(doc, counts.linked ?? links.length, 'Linked', 'mint'),
    createStatPill(doc, counts.visited ?? 0, 'Visited', 'default'),
    createStatPill(doc, counts.pending ?? 0, 'Pending', counts.pending ? 'gold' : 'default'),
    createStatPill(doc, graveyard.length || (counts.dead ?? 0), 'Fallen', (graveyard.length || counts.dead) ? 'danger' : 'default'),
  );
  if (counts.void) {
    pillsBar.append(createStatPill(doc, counts.void, 'Missed', 'muted'));
  }
  head.append(pillsBar);

  if (typeof onOpenRunTracker === 'function') {
    const openBtn = doc.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'party-open-tracker';
    openBtn.textContent = 'Open Run Tracker ›';
    openBtn.addEventListener('click', () => onOpenRunTracker());
    head.append(openBtn);
  }

  runSection.append(head);

  if (graveyard.length) {
    const graveyardSection = doc.createElement('details');
    graveyardSection.className = 'party-graveyard';
    graveyardSection.open = true;
    graveyardSection.setAttribute?.('open', '');
    const graveyardSummary = doc.createElement('summary');
    graveyardSummary.className = 'party-collapsible-summary';
    const graveyardHeading = doc.createElement('h4');
    graveyardHeading.textContent = `Graveyard (${graveyard.length})`;
    graveyardSummary.append(graveyardHeading);
    graveyardSection.append(graveyardSummary);

    const list = doc.createElement('ul');
    list.className = 'party-graveyard-list';
    for (const death of graveyard.slice(-12).reverse()) {
      const item = doc.createElement('li');
      item.className = 'party-graveyard-chip';
      const owner = (tracker.players ?? []).find((player) => player.playerId === death.playerId)?.name ?? 'Player';
      const monName = death.nickname || (death.species ? `#${death.species}` : 'Unknown');
      item.textContent = `${owner}’s ${monName} · ${death.cause || 'fainted'}`;
      list.append(item);
    }
    graveyardSection.append(list);
    runSection.append(graveyardSection);
  }

  return runSection;
}

export function renderPartyPanelInto(container, model, doc = globalThis.document, {
  moveRelearnerEnabled = false,
  onOpenMoveRelearner = null,
  onOpenRunTracker = null,
} = {}) {
  if (!container) return;
  const players = Array.isArray(model?.players) ? model.players : [];
  const links = Array.isArray(model?.links) ? model.links : [];
  const tracker = model?.runTracker;

  if (!players.length && (!tracker || tracker.status === 'unavailable')) {
    const empty = doc.createElement('p');
    empty.className = 'presence-note';
    empty.textContent = 'Join a room to see everyone’s party.';
    container.replaceChildren(empty);
    return;
  }

  const sections = [];

  if (players.length) {
    const grid = doc.createElement('div');
    grid.className = 'party-players-grid';
    grid.dataset.playerCount = String(players.length);
    for (const player of players) {
      grid.append(renderPlayerCard(doc, player, { moveRelearnerEnabled, onOpenMoveRelearner }));
    }
    sections.push(grid);
  }

  if (links.length) {
    sections.push(renderLinksSection(doc, links));
  }

  if (tracker && tracker.status !== 'unavailable') {
    sections.push(renderRunSummarySection(doc, tracker, links, { onOpenRunTracker }));
  }

  container.replaceChildren(...sections);
}
