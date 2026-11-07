import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStarterChoiceCards } from './starter-picker.mjs';

function createFakeDoc() {
  const makeEl = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      type: '',
      src: '',
      alt: '',
      width: 0,
      height: 0,
      draggable: true,
      dataset: {},
      children: [],
      listeners: {},
      append(...nodes) {
        this.children.push(...nodes);
      },
      replaceChildren(...nodes) {
        this.children = [...nodes];
      },
      addEventListener(event, fn) {
        this.listeners[event] = fn;
      },
    };
    return el;
  };
  return {
    createElement: makeEl,
  };
}

test('renderStarterChoiceCards renders sprite, name, and national dex for each choice', () => {
  const doc = createFakeDoc();
  const listEl = doc.createElement('div');
  const seedEl = doc.createElement('p');
  let selected = null;

  renderStarterChoiceCards({
    listEl,
    seedEl,
    seed: 12345,
    choices: [277, 280, 283],
    speciesInfoFor: (species) => ({
      species,
      nationalDex: species - 25,
      name: `Mon-${species}`,
      spriteUrl: `/graphics/pokemon/mon_${species}/front.png`,
    }),
    onSelect: (choice) => {
      selected = choice;
    },
    doc,
  });

  assert.equal(seedEl.textContent, 'Run seed 12345 · choose one for your run');
  assert.equal(listEl.children.length, 3);
  assert.equal(listEl.children[0].dataset.species, '277');
  assert.equal(listEl.children[0].dataset.nationalDex, '252');
  assert.equal(listEl.children[0].children[1].src, '/graphics/pokemon/mon_277/front.png');
  assert.equal(listEl.children[0].children[2].textContent, 'Mon-277');
  assert.equal(listEl.children[0].children[3].textContent, 'Dex #252');

  listEl.children[1].listeners.click();
  assert.deepEqual(selected, { species: 280, index: 1 });
});
