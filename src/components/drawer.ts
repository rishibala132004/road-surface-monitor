/**
 * A side drawer (settings, connection, raw signals, help). One drawer is
 * open at a time; Escape closes it.
 */
import { el } from '../utils/dom';
import { icons } from './icons';

export class Drawer {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  private static open: Drawer | null = null;
  private onCloseFns: (() => void)[] = [];

  constructor(host: HTMLElement, title: string, cls = '') {
    this.body = el('div', { class: 'drawer-body' });
    const close = el('button', {
      class: 'btn btn-icon btn-ghost',
      type: 'button',
      'aria-label': 'Close',
      html: icons.close,
    });
    close.addEventListener('click', () => this.hide());
    this.root = el(
      'aside',
      { class: `drawer ${cls}`, role: 'dialog', 'aria-label': title, hidden: true },
      [
        el('header', { class: 'drawer-head' }, [
          el('h2', { class: 't-display', text: title }),
          close,
        ]),
        this.body,
      ],
    );
    host.append(this.root);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    if (Drawer.open && Drawer.open !== this) Drawer.open.hide();
    Drawer.open = this;
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add('is-open'));
  }

  hide(): void {
    if (this.root.hidden) return;
    this.root.classList.remove('is-open');
    this.root.hidden = true;
    if (Drawer.open === this) Drawer.open = null;
    for (const fn of this.onCloseFns) fn();
  }

  toggle(): void {
    if (this.isOpen) this.hide();
    else this.show();
  }

  onClose(fn: () => void): void {
    this.onCloseFns.push(fn);
  }

  static closeAny(): boolean {
    if (!Drawer.open) return false;
    Drawer.open.hide();
    return true;
  }
}
