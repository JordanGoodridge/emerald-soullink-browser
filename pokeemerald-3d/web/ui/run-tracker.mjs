const SECTION_STATUS_LABEL = Object.freeze({
  unvisited: 'Not visited',
  available: 'Available',
  open: 'Available',
  claimed: 'Claimed',
  linked: 'Linked',
  pending: 'Pending',
  void: 'Missed',
  dead: 'Fallen',
});

function section(doc, title, className) {
  const node = doc.createElement('section');
  node.className = className;
  const heading = doc.createElement('h3');
  heading.textContent = title;
  node.append(heading);
  return node;
}

function createSummaryPill(doc, value, label, tone = 'default') {
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

export function renderRunTrackerInto(
  container,
  tracker,
  doc = globalThis.document,
  { speciesNameFor = () => null, currentArea = null } = {},
) {
  if (!container) return;
  if (!tracker || tracker.status === 'unavailable') {
    const empty = doc.createElement('p');
    empty.className = 'presence-note';
    empty.textContent = 'Start a Nuzlocke run to track visits and encounters.';
    container.replaceChildren(empty);
    return;
  }

  const out = [];
  const counts = tracker.summary ?? {};
  const graveyard = tracker.graveyard ?? [];

  const summaryBar = doc.createElement('div');
  summaryBar.className = 'party-stat-pills run-tracker-pills';
  summaryBar.append(
    createSummaryPill(doc, counts.visited ?? 0, 'Visited', 'default'),
    createSummaryPill(doc, counts.linked ?? 0, 'Linked', 'mint'),
    createSummaryPill(doc, counts.pending ?? 0, 'Pending', counts.pending ? 'gold' : 'default'),
    createSummaryPill(doc, counts.void ?? 0, 'Missed', counts.void ? 'muted' : 'default'),
    createSummaryPill(doc, graveyard.length || (counts.dead ?? 0), 'Fallen', (graveyard.length || counts.dead) ? 'danger' : 'default'),
  );
  out.push(summaryBar);

  const areas = section(doc, 'Routes & areas', 'run-tracker-section');
  if (currentArea) {
    const current = doc.createElement('p');
    current.className = 'run-tracker-current';
    current.textContent = `Current area: ${currentArea.label} · ${currentArea.status}`;
    areas.append(current);
  }
  const list = doc.createElement('ul');
  list.className = 'run-tracker-list';
  for (const entry of tracker.sections ?? []) {
    const item = doc.createElement('li');
    item.dataset.status = entry.status;

    const rowHead = doc.createElement('div');
    rowHead.className = 'run-tracker-row-head';

    const title = doc.createElement('strong');
    title.textContent = entry.label;

    const state = doc.createElement('span');
    state.className = 'run-status-badge';
    state.dataset.status = entry.status;
    state.textContent = SECTION_STATUS_LABEL[entry.status] ?? entry.status;

    rowHead.append(title, state);
    item.append(rowHead);

    const claimsWrap = doc.createElement('div');
    claimsWrap.className = 'run-tracker-claims';
    for (const area of entry.areas ?? []) {
      for (const member of area.members ?? []) {
        if (!member.species) continue;
        const mon = doc.createElement('small');
        mon.className = 'run-claim-chip';
        mon.dataset.status = member.status ?? 'alive';
        const monLabel = member.nickname || speciesNameFor(member.species) || `#${member.species}`;
        mon.textContent = `${member.name}: ${monLabel}`;
        claimsWrap.append(mon);
      }
    }
    if (claimsWrap.children?.length) {
      item.append(claimsWrap);
    }
    list.append(item);
  }
  areas.append(list);
  out.push(areas);

  const giftsSection = section(doc, 'Gifts & special encounters', 'run-tracker-section run-tracker-gifts');
  const gifts = doc.createElement('ul');
  gifts.className = 'run-tracker-list';
  for (const gift of tracker.gifts ?? []) {
    const item = doc.createElement('li');
    item.dataset.status = gift.status;

    const rowHead = doc.createElement('div');
    rowHead.className = 'run-tracker-row-head';

    const title = doc.createElement('strong');
    title.textContent = gift.label;

    const detail = doc.createElement('span');
    detail.className = 'run-status-badge';
    detail.dataset.status = gift.status;
    detail.textContent = SECTION_STATUS_LABEL[gift.status] ?? gift.status;

    rowHead.append(title, detail);
    item.append(rowHead);

    const claimsWrap = doc.createElement('div');
    claimsWrap.className = 'run-tracker-claims';
    for (const member of gift.members ?? []) {
      if (!member.species) continue;
      const chip = doc.createElement('small');
      chip.className = 'run-claim-chip';
      chip.dataset.status = member.status ?? 'alive';
      chip.textContent = `${member.name}: ${member.nickname || speciesNameFor(member.species) || `#${member.species}`}`;
      claimsWrap.append(chip);
    }
    if (claimsWrap.children?.length) {
      item.append(claimsWrap);
    }
    gifts.append(item);
  }
  if (!gifts.children.length) {
    const none = doc.createElement('li');
    none.className = 'run-tracker-empty';
    none.textContent = 'No gifts recorded yet.';
    gifts.append(none);
  }
  giftsSection.append(gifts);
  out.push(giftsSection);

  if (graveyard.length) {
    const graveyardSection = section(doc, `Graveyard (${graveyard.length})`, 'run-tracker-section party-graveyard');
    const graveList = doc.createElement('ul');
    graveList.className = 'party-graveyard-list';
    for (const death of graveyard.slice(-24).reverse()) {
      const item = doc.createElement('li');
      item.className = 'party-graveyard-chip';
      const owner = (tracker.players ?? []).find((player) => player.playerId === death.playerId)?.name ?? 'Player';
      const monLabel = death.nickname || speciesNameFor(death.species) || (death.species ? `#${death.species}` : 'Unknown');
      item.textContent = `${owner}’s ${monLabel} · ${death.cause || 'fainted'}`;
      graveList.append(item);
    }
    graveyardSection.append(graveList);
    out.push(graveyardSection);
  }

  container.replaceChildren(...out);
}
