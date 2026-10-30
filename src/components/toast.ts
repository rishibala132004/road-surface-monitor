/**
 * Short notices ("Live data from bike1", "Exported ride.jsonl").
 */
import { el } from '../utils/dom';

export class Toasts {
  constructor(private readonly root: HTMLElement) {}

  show(text: string, kind: 'info' | 'ok' | 'warn' = 'info', ms = 3600): void {
    const node = el('div', { class: `toast motion toast-${kind}`, role: 'status', text });
    this.root.append(node);
    requestAnimationFrame(() => node.classList.add('is-in'));
    setTimeout(() => {
      node.classList.remove('is-in');
      setTimeout(() => node.remove(), 400);
    }, ms);
  }
}
