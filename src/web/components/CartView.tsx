import type { Cart } from "../types";

export function CartView({ cart }: { cart: Cart | null }) {
  if (!cart) {
    return <p className="hint">No cart yet. Open the StartPage, shop, and return the cart — it lands here.</p>;
  }
  if (cart.items.length === 0) {
    return <p className="hint">Punchback received but the cart is empty.</p>;
  }
  return (
    <table className="cart-table">
      <thead>
        <tr>
          <th>Description</th>
          <th>SupplierPartID</th>
          <th>Aux ID</th>
          <th>UoM</th>
          <th className="num">Qty</th>
          <th className="num">Unit price</th>
          <th>Classification</th>
        </tr>
      </thead>
      <tbody>
        {cart.items.map((it, i) => (
          <tr key={i}>
            <td>{it.description}</td>
            <td>{it.supplierPartId}</td>
            <td>{it.supplierPartAuxiliaryId ?? "—"}</td>
            <td>{it.uom}</td>
            <td className="num">{it.quantity}</td>
            <td className="num">{it.currency} {it.unitPriceAmount?.toFixed(2)}</td>
            <td>
              {it.classifications?.length
                ? it.classifications.map((c) => `${c.domain}: ${c.value}`).join(", ")
                : it.classification}
            </td>
          </tr>
        ))}
      </tbody>
      {cart.total && (
        <tfoot>
          <tr>
            <td colSpan={4}></td>
            <td className="num">Total</td>
            <td className="num cart-total">
              {cart.total.currency} {cart.total.amount.toFixed(2)}
            </td>
            <td></td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}
