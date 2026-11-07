// DOM renderer and shareable PNG poster generator for the Post-Run Hall of Fame & Morgue sheet.

function createSpriteImg(doc, spriteUrl, alt, className = 'post-run-sprite') {
  if (!spriteUrl) return null;
  const img = doc.createElement('img');
  img.className = className;
  img.src = spriteUrl;
  img.alt = alt || 'Pokémon';
  img.width = 48;
  img.height = 48;
  img.loading = 'lazy';
  img.draggable = false;
  return img;
}

function createCollapsiblePostRunSection(doc, titleText, className, { open = true, badgeText = null } = {}) {
  const details = doc.createElement('details');
  details.className = className;
  if (open) {
    details.open = true;
    details.setAttribute?.('open', '');
  }
  const summary = doc.createElement('summary');
  summary.className = 'post-run-section-summary';
  const heading = doc.createElement('h3');
  heading.className = 'post-run-section-title';
  heading.textContent = titleText;
  summary.append(heading);
  if (badgeText !== null) {
    const count = doc.createElement('span');
    count.className = 'party-count-badge';
    count.textContent = String(badgeText);
    summary.append(count);
  }
  details.append(summary);
  return details;
}

export function renderPostRunSummaryInto(container, summary, doc = globalThis.document) {
  if (!container || !doc) return;
  if (!summary || summary.status === 'unavailable') {
    container.replaceChildren();
    return;
  }

  container.dataset.outcome = summary.outcome || 'wipe';
  const nodes = [];

  // 1. Active Rule Pills
  if (Array.isArray(summary.rulePills) && summary.rulePills.length > 0) {
    const rulesList = doc.createElement('ul');
    rulesList.className = 'post-run-rules';
    rulesList.setAttribute('aria-label', 'Active run rules');
    for (const pillText of summary.rulePills) {
      const li = doc.createElement('li');
      li.className = 'post-run-rule-pill';
      li.textContent = pillText;
      rulesList.append(li);
    }
    nodes.push(rulesList);
  }

  // 2. Core Stats Grid (single 6-column row on desktop)
  if (Array.isArray(summary.stats) && summary.stats.length > 0) {
    const statsSection = doc.createElement('section');
    statsSection.className = 'post-run-section post-run-stats-section';
    const grid = doc.createElement('div');
    grid.className = 'post-run-stats-grid';
    for (const stat of summary.stats) {
      const card = doc.createElement('article');
      card.className = 'post-run-stat-card';
      card.dataset.statId = stat.id;

      const label = doc.createElement('span');
      label.className = 'post-run-stat-label';
      label.textContent = stat.label;

      const value = doc.createElement('strong');
      value.className = 'post-run-stat-value';
      value.textContent = stat.value;

      const detail = doc.createElement('small');
      detail.className = 'post-run-stat-detail';
      detail.textContent = stat.detail;

      card.append(label, value, detail);
      grid.append(card);
    }
    statsSection.append(grid);
    nodes.push(statsSection);
  }

  // 3. Superlatives & Run Awards (collapsible)
  if (Array.isArray(summary.awards) && summary.awards.length > 0) {
    const awardsSection = createCollapsiblePostRunSection(
      doc,
      summary.outcome === 'victory' ? 'Hall of Fame Honors & Superlatives' : 'Run Superlatives & Honors',
      'post-run-section post-run-awards-section',
      { open: true, badgeText: summary.awards.length },
    );

    const awardsGrid = doc.createElement('div');
    awardsGrid.className = 'post-run-awards-grid';
    for (const award of summary.awards) {
      const card = doc.createElement('article');
      card.className = 'post-run-award-card';
      card.dataset.awardId = award.id;

      const topRow = doc.createElement('div');
      topRow.className = 'post-run-award-head';

      const badge = doc.createElement('span');
      badge.className = 'post-run-award-title';
      badge.textContent = `${award.icon ? `${award.icon} ` : ''}${award.title}`;
      topRow.append(badge);

      const sprite = createSpriteImg(doc, award.spriteUrl, award.headline, 'post-run-award-sprite');
      if (sprite) topRow.append(sprite);

      const headline = doc.createElement('strong');
      headline.className = 'post-run-award-headline';
      headline.textContent = award.headline;

      const detail = doc.createElement('p');
      detail.className = 'post-run-award-detail';
      detail.textContent = award.detail;

      card.append(topRow, headline, detail);
      awardsGrid.append(card);
    }
    awardsSection.append(awardsGrid);
    nodes.push(awardsSection);
  }

  // 4. Hall of Fame Champions / Final Party Roster (collapsible)
  const populatedRosters = (summary.champions ?? []).filter((r) => (r.members?.length ?? 0) > 0);
  if (populatedRosters.length > 0) {
    const totalRosterMons = populatedRosters.reduce((sum, r) => sum + (r.members?.length ?? 0), 0);
    const rosterSection = createCollapsiblePostRunSection(
      doc,
      summary.outcome === 'victory' ? 'Inducted Champion Lineup' : 'Final Party & Survivors',
      'post-run-section post-run-roster-section',
      { open: summary.outcome === 'victory', badgeText: totalRosterMons },
    );

    for (const playerRoster of populatedRosters) {
      const group = doc.createElement('div');
      group.className = 'post-run-player-roster';
      group.dataset.playerId = playerRoster.playerId;

      if (populatedRosters.length > 1 || summary.mode === 'soullink') {
        const subhead = doc.createElement('h4');
        subhead.className = 'post-run-player-heading';
        subhead.textContent = playerRoster.isSelf ? `${playerRoster.playerName} (you)` : playerRoster.playerName;
        group.append(subhead);
      }

      const list = doc.createElement('ul');
      list.className = 'post-run-mon-grid';
      for (const mon of playerRoster.members) {
        const item = doc.createElement('li');
        item.className = 'post-run-mon-card';
        item.dataset.status = mon.status;
        item.dataset.species = String(mon.species);

        const sprite = createSpriteImg(doc, mon.spriteUrl, mon.displayName, 'post-run-mon-sprite');
        if (sprite) item.append(sprite);

        const info = doc.createElement('div');
        info.className = 'post-run-mon-info';

        const nameLine = doc.createElement('strong');
        nameLine.className = 'post-run-mon-name';
        nameLine.textContent = `${mon.displayName}${mon.level ? ` · Lv ${mon.level}` : ''}`;

        const metaLine = doc.createElement('small');
        metaLine.className = 'post-run-mon-meta';
        metaLine.textContent = `Met at ${mon.originLabel}`;

        info.append(nameLine, metaLine);

        if (mon.partnerLabel) {
          const partnerLine = doc.createElement('small');
          partnerLine.className = 'post-run-mon-partner';
          partnerLine.textContent = `↔ ${mon.partnerLabel}`;
          info.append(partnerLine);
        }

        item.append(info);
        list.append(item);
      }
      group.append(list);
      rosterSection.append(group);
    }
    nodes.push(rosterSection);
  }

  // 5. The Fallen (Graveyard Epitaphs — collapsible)
  const graveyard = Array.isArray(summary.graveyard) ? summary.graveyard : [];
  const graveyardSection = createCollapsiblePostRunSection(
    doc,
    summary.outcome === 'victory'
      ? `Honored Fallen (${graveyard.length})`
      : `Run Morgue · Fallen Pokémon (${graveyard.length})`,
    'post-run-section post-run-graveyard-section',
    { open: graveyard.length > 0, badgeText: graveyard.length },
  );

  if (graveyard.length === 0) {
    const empty = doc.createElement('p');
    empty.className = 'post-run-empty';
    empty.textContent = 'Deathless run — not a single Pokémon was lost.';
    graveyardSection.append(empty);
  } else {
    const list = doc.createElement('ul');
    list.className = 'post-run-epitaph-grid';
    for (const fallen of graveyard) {
      const item = doc.createElement('li');
      item.className = 'post-run-epitaph-card';
      item.dataset.collateral = String(Boolean(fallen.isCollateral));
      item.dataset.species = String(fallen.species);

      const sprite = createSpriteImg(doc, fallen.spriteUrl, fallen.displayName, 'post-run-epitaph-sprite');
      if (sprite) item.append(sprite);

      const info = doc.createElement('div');
      info.className = 'post-run-epitaph-info';

      const title = doc.createElement('strong');
      title.className = 'post-run-epitaph-name';
      title.textContent = `${fallen.playerName}’s ${fallen.displayName}${fallen.level ? ` · Lv ${fallen.level}` : ''}`;

      const cause = doc.createElement('span');
      cause.className = 'post-run-epitaph-cause';
      cause.textContent = `${fallen.causeLabel} · ${fallen.splitLabel}`;

      const origin = doc.createElement('small');
      origin.className = 'post-run-epitaph-origin';
      origin.textContent = `Met at ${fallen.originLabel}${fallen.partnerLabel ? ` · ↔ ${fallen.partnerLabel}` : ''}`;

      info.append(title, cause, origin);
      item.append(info);
      list.append(item);
    }
    graveyardSection.append(list);
  }
  nodes.push(graveyardSection);

  // 6. Collapsible 8-Badge Split Timeline
  const activeSplits = (summary.splits ?? []).filter((s) => s.reached || s.catches.length > 0 || s.deaths.length > 0);
  if (activeSplits.length > 0) {
    const timeline = doc.createElement('details');
    timeline.className = 'post-run-timeline';
    const summaryEl = doc.createElement('summary');
    summaryEl.textContent = `Hoenn Gym Split Log (${summary.badgeCount}/8 Badges)`;
    timeline.append(summaryEl);

    const splitList = doc.createElement('ol');
    splitList.className = 'post-run-split-list';
    for (const split of activeSplits) {
      const li = doc.createElement('li');
      li.className = 'post-run-split-item';
      li.dataset.splitId = split.id;

      const head = doc.createElement('strong');
      head.textContent = `${split.title}`;

      const counts = doc.createElement('span');
      const catchNames = split.catches.map((c) => `${c.playerName}: ${c.displayName}`).join(', ');
      const deathNames = split.deaths.map((d) => `${d.playerName}: ${d.nickname || d.speciesName}`).join(', ');
      const parts = [];
      if (split.catches.length) parts.push(`Caught (${split.catches.length}): ${catchNames}`);
      if (split.deaths.length) parts.push(`Fallen (${split.deaths.length}): ${deathNames}`);
      if (!parts.length) parts.push('No catches or losses recorded in this split');
      counts.textContent = parts.join(' · ');

      li.append(head, counts);
      splitList.append(li);
    }
    timeline.append(splitList);
    nodes.push(timeline);
  }

  container.replaceChildren(...nodes);
}

export function renderPostRunPosterCanvas(summary, { doc = globalThis.document } = {}) {
  const canvas = doc.createElement('canvas');
  canvas.width = 800;
  canvas.height = 500;
  const ctx = canvas.getContext?.('2d');
  if (!ctx || !summary) return canvas;

  const isVictory = summary.outcome === 'victory';
  const borderBg = isVictory ? '#214d3e' : '#4a1c1c';
  const headerBg = isVictory ? '#1d5c47' : '#6e2222';
  const cardBg = '#fffdf1';
  const accent = isVictory ? '#d4a12a' : '#b64c3f';
  const ink = '#152540';
  const muted = '#586879';

  // Outer frame
  ctx.fillStyle = borderBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f4f1de';
  ctx.fillRect(10, 10, canvas.width - 20, canvas.height - 20);

  // Header Banner
  ctx.fillStyle = headerBg;
  ctx.fillRect(22, 22, canvas.width - 44, 88);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.strokeRect(22, 22, canvas.width - 44, 88);

  ctx.fillStyle = '#fff9db';
  ctx.font = 'bold 14px monospace';
  ctx.fillText(summary.kicker || 'POKETÉCH RUN SUMMARY', 38, 48);
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(summary.title || 'Run Summary', 38, 80);
  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#e7eccf';
  ctx.fillText(String(summary.subtitle || '').slice(0, 88), 38, 101);

  // Stats row (6 cards)
  const stats = (summary.stats ?? []).slice(0, 6);
  const statW = 118;
  const statGap = 8;
  stats.forEach((stat, idx) => {
    const x = 22 + idx * (statW + statGap);
    const y = 124;
    ctx.fillStyle = cardBg;
    ctx.fillRect(x, y, statW, 72);
    ctx.strokeStyle = '#c6cbbf';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, statW, 72);

    ctx.fillStyle = muted;
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(String(stat.label).slice(0, 16), x + 8, y + 20);
    ctx.fillStyle = ink;
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(String(stat.value).slice(0, 12), x + 8, y + 46);
    ctx.fillStyle = muted;
    ctx.font = '11px sans-serif';
    ctx.fillText(String(stat.detail).slice(0, 18), x + 8, y + 63);
  });

  // Awards section
  ctx.fillStyle = ink;
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText('RUN SUPERLATIVES & HONORS', 22, 222);

  const awards = (summary.awards ?? []).slice(0, 4);
  awards.forEach((award, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = 22 + col * 382;
    const y = 232 + row * 74;
    ctx.fillStyle = cardBg;
    ctx.fillRect(x, y, 370, 64);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, 370, 64);

    ctx.fillStyle = headerBg;
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`${award.icon || '★'} ${award.title}`.slice(0, 42), x + 10, y + 20);
    ctx.fillStyle = ink;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(String(award.headline || '').slice(0, 44), x + 10, y + 40);
    ctx.fillStyle = muted;
    ctx.font = '11px sans-serif';
    ctx.fillText(String(award.detail || '').slice(0, 56), x + 10, y + 56);
  });

  // Footer summary of Graveyard / Champions
  ctx.fillStyle = ink;
  ctx.font = 'bold 15px sans-serif';
  const fallenNames = (summary.graveyard ?? [])
    .slice(0, 6)
    .map((f) => `${f.playerName}’s ${f.nickname || f.speciesName}${f.level ? ` (Lv ${f.level})` : ''}`)
    .join(' · ');
  ctx.fillText(
    fallenNames ? `FALLEN: ${fallenNames}`.slice(0, 95) : 'DEATHLESS RUN · 0 FALLEN POKÉMON',
    22,
    415,
  );

  const ruleText = (summary.rulePills ?? []).join(' · ');
  ctx.fillStyle = muted;
  ctx.font = '12px monospace';
  ctx.fillText(`RULES: ${ruleText}`.slice(0, 95), 22, 445);
  ctx.fillText(`POKETÉCH · SEED ${summary.seed ?? '—'} · ${summary.badgeCount ?? 0}/8 BADGES`, 22, 468);

  return canvas;
}

export function downloadPostRunPoster(summary, { doc = globalThis.document } = {}) {
  const canvas = renderPostRunPosterCanvas(summary, { doc });
  if (typeof canvas.toDataURL !== 'function') return false;
  const dataUrl = canvas.toDataURL('image/png');
  const link = doc.createElement('a');
  const slug = summary?.outcome === 'victory' ? 'hall-of-fame' : 'run-summary';
  link.download = `poketech-${slug}-${summary?.seed ?? 'run'}.png`;
  link.href = dataUrl;
  link.click?.();
  return true;
}
