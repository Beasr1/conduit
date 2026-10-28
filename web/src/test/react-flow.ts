// jsdom does no layout, and React Flow measures nodes before it draws edges.
// shimReactFlow gives it what it measures with, so a canvas renders in a
// test. React Flow's testing guide lists the same pieces; a real browser
// needs none of them.
export function shimReactFlow() {
  // Reports each observed element once, a tick later, as a browser does after
  // laying it out.
  class Observer {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      // A stand-in with the two fields React Flow reads: the target, whose
      // size it measures, and contentRect, which bounds panning and zoom.
      const { offsetWidth = 1, offsetHeight = 1 } = target as HTMLElement;
      const entry = {
        target,
        contentRect: new DOMRect(0, 0, offsetWidth, offsetHeight),
      } as ResizeObserverEntry;
      setTimeout(() => this.callback([entry], this));
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = Observer;

  // React Flow reads the zoom out of the viewport's CSS transform.
  class Matrix {
    m22: number;
    constructor(transform?: string) {
      const scale = /scale\(([\d.]+)\)/.exec(transform ?? "")?.[1];
      this.m22 = scale === undefined ? 1 : Number(scale);
    }
  }
  // A stand-in for the one field React Flow uses.
  globalThis.DOMMatrixReadOnly = Matrix as unknown as typeof DOMMatrixReadOnly;

  // An element's size is its inline width and height, which React Flow sets
  // on every node it was given a size for.
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return parseFloat(this.style.width) || 1;
      },
    },
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return parseFloat(this.style.height) || 1;
      },
    },
  });
  // React Flow measures an edge's label with getBBox, which jsdom lacks.
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => new DOMRect(0, 0, 0, 0),
  });
}
