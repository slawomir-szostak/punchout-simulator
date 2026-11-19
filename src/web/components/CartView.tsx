import type { Cart } from "../types";

export function CartView({ cart }: { cart: Cart | null }) {
  if (!cart) {
    return <p className="hint">No cart yet. Open the StartPage, shop, and return the cart — it lands here.</p>;
  }
  // What the punchback means for the requisition (cXML Reference Guide, "Empty
  // Shopping Carts") — decided server-side from the session's operation.
  const note =
    cart.outcome === "cancelled"
      ? "The session was cancelled — the supplier returned no items, so nothing is added to the requisition."
      : cart.outcome === "emptied"
        ? "The edit session came back empty — the items it carried are deleted from the requisition."
        : cart.outcome === "unchanged"
          ? "The edit session was cancelled without change (Status 204) — the requisition keeps the items it had."
          : cart.outcome === "inspected"
            ? "Inspect session — whatever the supplier returned is ignored; the items stay as they were sent."
            : null;
  if (cart.items.length === 0) {
    return <p className="hint">{note ?? "Punchback received but the cart is empty."}</p>;
  }
  // The supplier may quote shipping and tax beside the Total, which is goods only.
  const charges = !!(cart.shipping || cart.tax);
  return (
    <>
    {note && <p className="hint">{note}</p>}
    <table className="cart-table">
      <thead>
        <tr>
          <th>Description</th>
          <th>SupplierPartID</th>
          <th>Aux ID</th>
          <th>Classification</th>
          <th>UoM</th>
          <th className="num">Qty</th>
          <th className="num">Unit price</th>
        </tr>
      </thead>
      <tbody>
        {cart.items.map((it, i) => (
          <tr key={i}>
            <td>{it.description}</td>
            <td>{it.supplierPartId}</td>
            <td>{it.supplierPartAuxiliaryId ?? "—"}</td>
            <td>
              {it.classifications?.length
                ? it.classifications.map((c) => `${c.domain}: ${c.value}`).join(", ")
                : it.classification}
            </td>
            <td>{it.uom}</td>
            <td className="num">{it.quantity}</td>
            <td className="num">{it.currency} {it.unitPriceAmount?.toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
      {cart.total && (
        <tfoot>
          <tr>
            <td colSpan={5}></td>
            <td className="num">{charges ? "Goods total" : "Total"}</td>
            <td className="num cart-total">
              {cart.total.currency} {cart.total.amount.toFixed(2)}
            </td>
          </tr>
          {cart.shipping && (
            <tr>
              <td colSpan={5} className="num hint">{cart.shipping.description}</td>
              <td className="num">Shipping</td>
              <td className="num">{cart.shipping.currency} {cart.shipping.amount.toFixed(2)}</td>
            </tr>
          )}
          {cart.tax && (
            <tr>
              <td colSpan={5} className="num hint">{cart.tax.description}</td>
              <td className="num">Tax</td>
              <td className="num">{cart.tax.currency} {cart.tax.amount.toFixed(2)}</td>
            </tr>
          )}
          {charges && (
            <tr>
              <td colSpan={5}></td>
              <td className="num">To pay</td>
              <td className="num cart-total">
                {cart.total.currency} {(cart.total.amount + (cart.shipping?.amount ?? 0) + (cart.tax?.amount ?? 0)).toFixed(2)}
              </td>
            </tr>
          )}
        </tfoot>
      )}
    </table>
    {cart.operationAllowed && cart.outcome === "returned" && (
      <p className="hint">
        The supplier allows this cart to be{" "}
        {cart.operationAllowed === "edit"
          ? "reopened later to inspect or edit"
          : cart.operationAllowed === "inspect"
            ? "reopened later to inspect only"
            : "ordered only — no later edit or inspect"}{" "}
        (<code>operationAllowed="{cart.operationAllowed}"</code>).
      </p>
    )}
    </>
  );
}
