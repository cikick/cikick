import type { IConstruct } from 'constructs';

export interface IAspect {
  visit(node: IConstruct): void;
}

const KEY = Symbol.for('@cikick/core.Aspects');

export class Aspects {
  static of(scope: IConstruct): Aspects {
    let a = (scope as any)[KEY] as Aspects | undefined;
    if (!a) {
      a = new Aspects();
      Object.defineProperty(scope, KEY, { value: a, enumerable: false });
    }
    return a;
  }

  private readonly list: IAspect[] = [];
  add(aspect: IAspect): void {
    this.list.push(aspect);
  }
  get all(): readonly IAspect[] {
    return this.list;
  }
}

/** Apply aspects top-down: each node is visited by aspects of itself and all its ancestors. */
export function applyAspects(root: IConstruct): void {
  const seen = new Map<IConstruct, Set<IAspect>>();
  const walk = (node: IConstruct, inherited: readonly IAspect[]) => {
    const list = [...inherited, ...Aspects.of(node).all];
    let done = seen.get(node);
    if (!done) seen.set(node, (done = new Set()));
    for (const a of list) {
      if (done.has(a)) continue;
      done.add(a);
      a.visit(node);
    }
    // re-read children after visiting: aspects may add nodes
    for (const child of node.node.children) walk(child, list);
  };
  walk(root, []);
}
