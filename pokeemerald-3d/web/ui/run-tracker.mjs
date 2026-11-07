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

const SECTION_STATUS_PRIORITY = Object.freeze({
  pending: 0,
  linked: 1,
  claimed: 2,
  available: 3,
  open: 3,
  dead: 4,
  void: 5,
  unvisited: 6,
});

function collapsibleSection(doc, title, className, { open = true, badgeText = null, extraHeaderNode = null } = {}) {
  const node = doc.createElement('details');
  node.className = className;
  if (open) {
    node.open = true;
    node.setAttribute?.('open', '');
  }
  const summary = doc.createElement('summary');
  summary.className = 'run-tracker-section-summary';
  const heading = doc.createElement('h3');
  heading.textContent = title;
  summary.append(heading);

  if (extraHeaderNode || badgeText !== null) {
    const meta = doc.createElement('div');
    meta.className = 'run-tracker-section-meta';
    if (extraHeaderNode) meta.append(extraHeaderNode);
    if (badgeText !== null) {
      const count = doc.createElement('span');
      count.className = 'party-count-badge';
      count.textContent = String(badgeText);
      meta.append(count);
    }
    summary.append(meta);
  }

  node.append(summary);
  return node;
}

function createSummaryPill(doc, value, label, tone = 'default', filterKey = null) {
  const pill = doc.createElement('span');
  pill.className = 'party-stat-pill';
  pill.dataset.tone = tone;
  if (filterKey) {
    pill.dataset.filter = filterKey;
  }
  const num = doc.createElement('strong');
  num.textContent = String(value);
  const text = doc.createElement('span');
  text.textContent = label;
  pill.append(num, text);
  return pill;
}

function renderSectionRow(doc, entry, speciesNameFor) {
  const item = doc.createElement('li');
  item.dataset.status = entry.status;
  item.dataset.visited = entry.visited ? 'true' : 'false';

  const rowHead = doc.createElement('div');
  rowHead.className = 'run-tracker-row-head';

  const title = doc.createElement('strong');
  title.textContent = entry.label;
  rowHead.append(title);

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
    rowHead.append(claimsWrap);
  }

  const state = doc.createElement('span');
  state.className = 'run-status-badge';
  state.dataset.status = entry.status;
  state.textContent = SECTION_STATUS_LABEL[entry.status] ?? entry.status;

  rowHead.append(state);
  item.append(rowHead);
  return item;
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
  const pills = [
    createSummaryPill(doc, counts.visited ?? 0, 'Visited', 'default', 'visited'),
    createSummaryPill(doc, counts.linked ?? 0, 'Linked', 'mint', 'linked'),
    createSummaryPill(doc, counts.pending ?? 0, 'Pending', counts.pending ? 'gold' : 'default', 'pending'),
    createSummaryPill(doc, counts.void ?? 0, 'Missed', counts.void ? 'muted' : 'default', 'void'),
    createSummaryPill(doc, graveyard.length || (counts.dead ?? 0), 'Fallen', (graveyard.length || counts.dead) ? 'danger' : 'default', 'dead'),
  ];
  summaryBar.append(...pills);
  out.push(summaryBar);

  let currentBadge = null;
  if (currentArea) {
    currentBadge = doc.createElement('span');
    currentBadge.className = 'run-tracker-current';
    currentBadge.textContent = `📍 ${currentArea.label} · ${currentArea.status}`;
  }

  const allSections = tracker.sections ?? [];
  const currentLabelUpper = currentArea?.label ? String(currentArea.label).toUpperCase() : null;
  const activeSections = [];
  const unvisitedSections = [];
  for (const entry of allSections) {
    const isCurrent = currentLabelUpper && String(entry.label ?? '').toUpperCase() === currentLabelUpper;
    if (entry.status !== 'unvisited' || entry.visited || isCurrent) {
      activeSections.push(entry);
    } else {
      unvisitedSections.push(entry);
    }
  }

  activeSections.sort((a, b) => {
    const aCurrent = currentLabelUpper && String(a.label ?? '').toUpperCase() === currentLabelUpper ? 0 : 1;
    const bCurrent = currentLabelUpper && String(b.label ?? '').toUpperCase() === currentLabelUpper ? 0 : 1;
    if (aCurrent !== bCurrent) return aCurrent - bCurrent;
    const aPrio = SECTION_STATUS_PRIORITY[a.status] ?? 9;
    const bPrio = SECTION_STATUS_PRIORITY[b.status] ?? 9;
    return aPrio - bPrio;
  });

  const areas = collapsibleSection(doc, 'Routes & areas', 'run-tracker-section', {
    open: true,
    badgeText: `${activeSections.length} active`,
    extraHeaderNode: currentBadge,
  });

  const list = doc.createElement('ul');
  list.className = 'run-tracker-list';
  const primaryEntries = activeSections.length > 0 ? activeSections : unvisitedSections;
  const renderedRows = [];
  for (const entry of primaryEntries) {
    const row = renderSectionRow(doc, entry, speciesNameFor);
    renderedRows.push(row);
    list.append(row);
  }
  areas.append(list);

  // Wire interactive filter pills when running in a live DOM
  let activeFilter = null;
  for (const pill of pills) {
    pill.addEventListener?.('click', () => {
      const key = pill.dataset.filter;
      activeFilter = activeFilter === key ? null : key;
      for (const p of pills) {
        p.dataset.active = activeFilter === p.dataset.filter ? 'true' : 'false';
      }
      for (const row of renderedRows) {
        const matches = !activeFilter
          || (activeFilter === 'visited' ? row.dataset.visited === 'true' || row.dataset.status !== 'unvisited' : row.dataset.status === activeFilter);
        row.hidden = !matches;
      }
    });
  }

  if (activeSections.length > 0 && unvisitedSections.length > 0) {
    const unvisitedDetails = doc.createElement('details');
    unvisitedDetails.className = 'run-tracker-unvisited';
    const unvisitedSummary = doc.createElement('summary');
    unvisitedSummary.className = 'run-tracker-unvisited-summary';
    unvisitedSummary.textContent = `Unvisited areas (${unvisitedSections.length})`;
    const unvisitedList = doc.createElement('ul');
    unvisitedList.className = 'run-tracker-list';
    for (const entry of unvisitedSections) {
      unvisitedList.append(renderSectionRow(doc, entry, speciesNameFor));
    }
    unvisitedDetails.append(unvisitedSummary, unvisitedList);
    areas.append(unvisitedDetails);
  }
  out.push(areas);

  const giftItems = tracker.gifts ?? [];
  const giftsSection = collapsibleSection(doc, 'Gifts & special encounters', 'run-tracker-section run-tracker-gifts', {
    open: giftItems.length > 0,
    badgeText: giftItems.length,
  });
  const gifts = doc.createElement('ul');
  gifts.className = 'run-tracker-list';
  for (const gift of giftItems) {
    const item = doc.createElement('li');
    item.dataset.status = gift.status;

    const rowHead = doc.createElement('div');
    rowHead.className = 'run-tracker-row-head';

    const title = doc.createElement('strong');
    title.textContent = gift.label;
    rowHead.append(title);

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
      rowHead.append(claimsWrap);
    }

    const detail = doc.createElement('span');
    detail.className = 'run-status-badge';
    detail.dataset.status = gift.status;
    detail.textContent = SECTION_STATUS_LABEL[gift.status] ?? gift.status;

    rowHead.append(detail);
    item.append(rowHead);
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
    const graveyardSection = collapsibleSection(doc, `Graveyard (${graveyard.length})`, 'run-tracker-section party-graveyard', {
      open: true,
    });
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
