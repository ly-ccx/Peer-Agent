import assert from 'node:assert/strict';
import test from 'node:test';
import { createInteractionLayers, interactionLayers, ownsLayerPointer, type InteractionLayer } from './interactionLayers.ts';
function node(parent: HTMLElement | null = null): HTMLElement {
  const value = { parentElement: parent, contains(other: Node | null) {
    for (let at = other as HTMLElement | null; at; at = at.parentElement) if (at === (value as unknown as HTMLElement)) return true;
    return false;
  } };
  return value as unknown as HTMLElement;
}
const layer = (root: HTMLElement, trigger: HTMLElement | null = null, modal = false): InteractionLayer => ({ roots: () => [root], trigger, modal });
test('portalled menu and tooltip belong to the containing modal while passive hints do not own Tab or outside pointers', () => {
  const stack = createInteractionLayers(), root = node(), menuRoot = node(), tipRoot = node();
  const modal = layer(root, null, true), menu = layer(menuRoot, node(root));
  const tip = { ...layer(tipRoot, node(menuRoot)), passive: true };
  stack.add(modal); const removeMenu = stack.add(menu); const removeTip = stack.add(tip);
  assert.equal(stack.top(), tip); assert.equal(stack.topInteractive(), menu); assert.equal(stack.modal(), modal);
  assert.equal(stack.contains(modal, tipRoot), true); assert.equal(stack.contains(menu, root), false);
  removeTip(); removeMenu(); assert.equal(stack.top(), modal);
});
test('logical parents preserve nested modal order even when child layout effects register first', () => {
  const stack = createInteractionLayers(), parent = layer(node(), null, true);
  const child: InteractionLayer = { ...layer(node(), null, true), parent: () => parent };
  stack.add(child); stack.add(parent);
  assert.equal(stack.top(), child); assert.equal(stack.modal(), child);
  assert.equal(stack.contains(parent, child.roots()[0]!), true);
});
test('one outside pointer cannot dismiss the layer underneath a synchronously removed menu', () => {
  const bottom = layer(node()), top = layer(node());
  const removeBottom = interactionLayers.add(bottom), removeTop = interactionLayers.add(top);
  try {
    const event = new Event('pointerdown');
    assert.equal(ownsLayerPointer(top, event), true); removeTop();
    assert.equal(ownsLayerPointer(bottom, event), false);
    assert.equal(ownsLayerPointer(bottom, new Event('pointerdown')), true);
  } finally { removeTop(); removeBottom(); }
});
