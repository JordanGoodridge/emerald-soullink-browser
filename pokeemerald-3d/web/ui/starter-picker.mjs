// Starter choice card DOM renderer for Nuzlocke / SoulLink runs.

export function renderStarterChoiceCards({
  listEl,
  seedEl,
  seed,
  choices,
  speciesInfoFor,
  onSelect,
  doc = globalThis.document,
}) {
  if (!listEl) return;
  listEl.replaceChildren();
  if (seedEl) {
    seedEl.textContent = `Run seed ${seed} · choose one for your run`;
  }
  choices.forEach((species, index) => {
    const info = speciesInfoFor(species);
    const dexNumber = Number.isInteger(info.nationalDex) ? info.nationalDex : species;
    const dexFormatted = `#${String(dexNumber).padStart(3, '0')}`;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'starter-choice-card';
    button.dataset.choiceIndex = String(index);
    button.dataset.species = String(species);
    if (Number.isInteger(info.nationalDex)) {
      button.dataset.nationalDex = String(info.nationalDex);
    }

    const badge = doc.createElement('span');
    badge.className = 'starter-choice-number';
    badge.textContent = `Choice ${index + 1}`;
    button.append(badge);

    if (info.spriteUrl) {
      const sprite = doc.createElement('img');
      sprite.className = 'starter-choice-sprite';
      sprite.src = info.spriteUrl;
      sprite.alt = info.name;
      sprite.width = 64;
      sprite.height = 64;
      sprite.draggable = false;
      button.append(sprite);
    }

    const nameEl = doc.createElement('strong');
    nameEl.className = 'starter-choice-name';
    nameEl.textContent = info.name;

    const dexEl = doc.createElement('span');
    dexEl.className = 'starter-choice-dex';
    dexEl.textContent = `Dex ${dexFormatted}`;

    button.append(nameEl, dexEl);
    button.addEventListener('click', () => onSelect?.({ species, index }), { once: true });
    listEl.append(button);
  });
}
