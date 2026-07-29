export interface DisposableResource {
  dispose(): void;
}

interface IndexedResourceEntry<ElementType, ResourceType extends DisposableResource> {
  readonly element: ElementType;
  readonly resource: ResourceType;
}

/**
 * Owns exactly one disposable resource per virtual item index.
 *
 * React callback refs can deliver an old element's `null` after a replacement
 * element for the same index has already mounted. Releasing by index alone can
 * therefore dispose the replacement. The optional expected element keeps
 * ownership exact and makes late cleanup idempotent.
 */
export class IndexedResourceRegistry<ElementType, ResourceType extends DisposableResource> {
  private readonly entries = new Map<number, IndexedResourceEntry<ElementType, ResourceType>>();

  replace(index: number, element: ElementType, create: () => ResourceType): ResourceType {
    const current = this.entries.get(index);
    if (current?.element === element) return current.resource;
    current?.resource.dispose();
    const resource = create();
    this.entries.set(index, { element, resource });
    return resource;
  }

  release(index: number, expectedElement?: ElementType): boolean {
    const current = this.entries.get(index);
    if (!current) return false;
    if (expectedElement !== undefined && current.element !== expectedElement) return false;
    current.resource.dispose();
    this.entries.delete(index);
    return true;
  }

  forEach(
    callback: (element: ElementType, index: number, resource: ResourceType) => void,
  ): void {
    for (const [index, { element, resource }] of this.entries) {
      callback(element, index, resource);
    }
  }

  clear(): void {
    for (const { resource } of this.entries.values()) resource.dispose();
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
