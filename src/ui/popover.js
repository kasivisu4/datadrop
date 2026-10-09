// A small popover / menu behaviour for a trigger button and a hidden panel: toggle on click, close on Escape (focus returns
// to the trigger) and on a click outside, arrow keys move between the panel's buttons. Only one popover is open at a time.
const FOCUSABLE = '[role^="menuitem"]:not([disabled]), button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])';
let openOne = null;

export function attachPopover(trigger, panel, { onOpen, onClose, focusFirst = true } = {}) {
  const api = {
    get isOpen() { return !panel.hidden; },
    open() {
      if (openOne && openOne !== api) openOne.close(false);
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      openOne = api;
      onOpen?.();
      if (focusFirst) panel.querySelector(FOCUSABLE)?.focus();
    },
    close(refocus = true) {
      if (panel.hidden) return;
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (openOne === api) openOne = null;
      onClose?.();
      if (refocus) trigger.focus();
    },
    toggle() { api.isOpen ? api.close() : api.open(); },
  };
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('click', (e) => { e.stopPropagation(); api.toggle(); });
  trigger.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !api.isOpen) { e.preventDefault(); api.open(); }
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    if (e.target.matches?.('input, select')) return;
    const items = [...panel.querySelectorAll(FOCUSABLE)];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  });
  api.trigger = trigger; api.panel = panel;
  return api;
}
// one listener for every popover: a click outside the open one closes it
document.addEventListener('pointerdown', (e) => {
  if (openOne && !openOne.panel.contains(e.target) && !openOne.trigger.contains(e.target)) openOne.close(false);
});
