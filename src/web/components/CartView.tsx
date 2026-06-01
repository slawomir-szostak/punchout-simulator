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
          <th>Qty</th>
          <th>SupplierPartID</th>
          <th>Description</th>
          <th>UoM</th>
          <th>Unit price</th>
          <th>UNSPSC</th>
        </tr>
      </thead>
      <tbody>
        {cart.items.map((it, i) => (
          <tr key={i}>
            <td>{it.quantity}</td>
            <td>{it.supplierPartId}</td>
            <td>{it.description}</td>
            <td>{it.uom}</td>
            <td>
              {it.currency} {it.unitPriceAmount?.toFixed(2)}
            </td>
            <td>{it.classification}</td>
          </tr>
        ))}
      </tbody>
      {cart.total && (
        <tfoot>
          <tr>
            <td colSpan={4}></td>
            <td className="cart-total">
              {cart.total.currency} {cart.total.amount.toFixed(2)}
            </td>
            <td></td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}
