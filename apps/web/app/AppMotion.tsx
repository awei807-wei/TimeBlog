'use client';

import { Suspense, useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

const controls = 'button, [role="button"], a[href], input[type="submit"], input[type="button"], input[type="reset"], input[type="image"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], summary, [cmdk-item], label[class*="button"]';
const pressedAttribute = 'data-press-feedback';

/** One delegated listener set also covers controls rendered in portals. */
export function installPressFeedback(doc: Document, win: Window) {
  let pressed: Element | null = null;
  let pointerId: number | null = null;
  let key: string | null = null;
  let originX = 0;
  let originY = 0;
  const clear = () => {
    pressed?.removeAttribute(pressedAttribute);
    pressed = null;
    pointerId = null;
    key = null;
  };
  const findControl = (target: EventTarget | null) => {
    const element = target as Element | null;
    if (!element?.closest || element.closest('[contenteditable="true"], input:not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="file"]), textarea, select')) return null;
    const control = element.closest(controls);
    if (!control || control.matches(':disabled, [disabled], [data-disabled]:not([data-disabled="false"])') || control.closest('[inert], [aria-disabled="true"]')) return null;
    if (control.tagName === 'LABEL' && (control as HTMLLabelElement).control?.matches(':disabled')) return null;
    return control;
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    clear();
    pressed = findControl(event.target);
    if (!pressed) return;
    pointerId = event.pointerId;
    originX = event.clientX;
    originY = event.clientY;
    pressed.setAttribute(pressedAttribute, '');
  };
  const release = (event: PointerEvent) => {
    if (event.pointerId === pointerId) clear();
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId === pointerId && Math.hypot(event.clientX - originX, event.clientY - originY) > 10) clear();
  };
  const leave = (event: PointerEvent) => {
    if (event.pointerId === pointerId && pressed && !pressed.contains(event.relatedTarget as Node | null)) clear();
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !['Enter', ' '].includes(event.key)) return;
    const control = findControl(event.target);
    // Space scrolls native links; do not pretend it activates them.
    if (!control || (event.key === ' ' && control.matches('a[href]:not([role="button"])'))) return;
    clear();
    pressed = control;
    key = event.key;
    pressed.setAttribute(pressedAttribute, '');
  };
  const keyUp = (event: KeyboardEvent) => { if (event.key === key) clear(); };
  const focusOut = (event: FocusEvent) => {
    if (pressed && event.target && 'nodeType' in event.target && pressed.contains(event.target as Node)) clear();
  };
  doc.addEventListener('pointerdown', down, { capture: true, passive: true });
  doc.addEventListener('pointerup', release, true);
  doc.addEventListener('pointercancel', release, true);
  doc.addEventListener('pointermove', move, { capture: true, passive: true });
  doc.addEventListener('pointerout', leave, true);
  doc.addEventListener('keydown', keyDown, true);
  doc.addEventListener('keyup', keyUp, true);
  doc.addEventListener('focusout', focusOut, true);
  doc.addEventListener('visibilitychange', clear);
  win.addEventListener('blur', clear);
  win.addEventListener('pagehide', clear);
  return () => {
    clear();
    doc.removeEventListener('pointerdown', down, true);
    doc.removeEventListener('pointerup', release, true);
    doc.removeEventListener('pointercancel', release, true);
    doc.removeEventListener('pointermove', move, true);
    doc.removeEventListener('pointerout', leave, true);
    doc.removeEventListener('keydown', keyDown, true);
    doc.removeEventListener('keyup', keyUp, true);
    doc.removeEventListener('focusout', focusOut, true);
    doc.removeEventListener('visibilitychange', clear);
    win.removeEventListener('blur', clear);
    win.removeEventListener('pagehide', clear);
  };
}

function RouteArrival() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  // Editing/query-driven draft updates should never animate the writing surface.
  const route = pathname.startsWith('/admin') ? pathname : `${pathname}?${search}`;
  const previous = useRef(route);
  useEffect(() => {
    if (previous.current === route) return;
    previous.current = route;
    // The article route owns its loading/timeout/failure and ready animation.
    if (pathname.startsWith('/article/')) return;
    const content = document.querySelector<HTMLElement>('.public-content, .app-content');
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!content || preference.matches) return;
    content.classList.add('site-route-arrival');
    // A second commit can arrive before the first 200ms animation ends.
    // Flush only animation styles and restart our animation, not child effects.
    for (const animation of content.getAnimations?.() ?? []) {
      if ('animationName' in animation && animation.animationName === 'site-route-arrival') animation.currentTime = 0;
    }
    const clear = () => content.classList.remove('site-route-arrival');
    const end = (event: AnimationEvent) => { if (event.target === content && event.animationName === 'site-route-arrival') clear(); };
    content.addEventListener('animationend', end);
    preference.addEventListener('change', clear);
    return () => {
      clear();
      content.removeEventListener('animationend', end);
      preference.removeEventListener('change', clear);
    };
  }, [pathname, route]);
  return null;
}

/** Null siblings preserve the exact shell/content tree and SessionProvider. */
export default function AppMotion() {
  useEffect(() => installPressFeedback(document, window), []);
  return <Suspense fallback={null}><RouteArrival /></Suspense>;
}
