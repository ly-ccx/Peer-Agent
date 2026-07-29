import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IndexedResourceRegistry } from './indexedResourceRegistry.ts';

class TestResource {
  disposeCount = 0;

  dispose(): void {
    this.disposeCount += 1;
  }
}

describe('indexed resource ownership', () => {
  it('does not grow or release the replacement during repeated delayed cleanup', () => {
    const registry = new IndexedResourceRegistry<object, TestResource>();
    let previousElement: object | null = null;
    let previousResource: TestResource | null = null;

    for (let switchIndex = 0; switchIndex < 20; switchIndex += 1) {
      const nextElement = {};
      const nextResource = new TestResource();
      registry.replace(0, nextElement, () => nextResource);

      // React may deliver the old callback ref's null after the replacement mounted.
      if (previousElement && previousResource) {
        assert.equal(registry.release(0, previousElement), false);
        assert.equal(previousResource.disposeCount, 1);
      }

      assert.equal(registry.size, 1);
      assert.equal(nextResource.disposeCount, 0);
      previousElement = nextElement;
      previousResource = nextResource;
    }

    registry.clear();
    assert.equal(registry.size, 0);
    assert.equal(previousResource?.disposeCount, 1);
  });

  it('keeps mounted resources alive while an owner switch remeasures them', () => {
    const registry = new IndexedResourceRegistry<object, TestResource>();
    const resources: TestResource[] = [];

    for (let index = 0; index < 8; index += 1) {
      const resource = new TestResource();
      resources.push(resource);
      registry.replace(index, {}, () => resource);
    }

    for (let switchIndex = 0; switchIndex < 20; switchIndex += 1) {
      const visited: number[] = [];
      registry.forEach((_element, index, resource) => {
        visited.push(index);
        assert.equal(resource.disposeCount, 0);
      });
      assert.deepEqual(visited, [0, 1, 2, 3, 4, 5, 6, 7]);
      assert.equal(registry.size, 8);
    }

    // Only unmount owns the destructive clear.
    registry.clear();
    assert.equal(registry.size, 0);
    assert.deepEqual(resources.map((resource) => resource.disposeCount), Array(8).fill(1));
  });
});
