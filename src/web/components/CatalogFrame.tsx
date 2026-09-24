import { useEffect, useRef } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import type { Cart } from "../types";

interface Props {
  /** The supplier's StartPage URL (already theme-decorated, http(s) only). */
  src: string;
  /** The session's cart at the time the frame was opened (null when none). */
  cartAtOpen: Cart | null;
  /** The session's current cart — a new object means the punchback landed. */
  cart: Cart | null;
  onClose: () => void;
}

// How long the supplier's receipt page stays visible inside the frame once
// the punchback has landed, before the overlay closes itself.
const CLOSE_DELAY_MS = 1500;

/**
 * Embeds the supplier's catalog in an iframe overlay instead of a new tab, the
 * way some procurement systems (Coupa, Ariba Guided Buying) present punchout.
 * Framing surfaces problems a new-tab run never hits: X-Frame-Options / CSP
 * frame-ancestors blocking, third-party-cookie loss, and a punchback form that
 * targets `_top` and navigates the buyer UI away. The iframe is deliberately
 * not sandboxed so the catalog behaves as it would in a real procurement frame.
 */
export function CatalogFrame({ src, cartAtOpen, cart, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, onClose);

  // The cart arrives over SSE independently of the frame, so a new cart object
  // is the "shopping finished" signal regardless of the punchback transport.
  useEffect(() => {
    if (cart === cartAtOpen) return;
    const t = setTimeout(onClose, CLOSE_DELAY_MS);
    return () => clearTimeout(t);
  }, [cart, cartAtOpen, onClose]);

  return (
    <div className="modal-backdrop">
      <div className="modal catalog-frame" role="dialog" aria-modal="true" aria-label="Embedded catalog" tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <div>
            <strong>Embedded catalog</strong> <code className="catalog-frame-url">{src}</code>
          </div>
          <button className="btn-link" onClick={onClose}>close ✕</button>
        </div>
        <iframe className="catalog-frame-body" src={src} title="Supplier catalog" />
        <p className="hint">
          Blank frame → the supplier most likely sends <code>X-Frame-Options</code> or CSP{" "}
          <code>frame-ancestors</code> (see the Network tab). Logged out / cart lost inside the frame → its session
          cookie lacks <code>SameSite=None; Secure</code> or the browser blocks third-party cookies. Whole page
          navigated away → the punchback form targets <code>_top</code>. The overlay closes itself once the cart lands.
        </p>
      </div>
    </div>
  );
}
