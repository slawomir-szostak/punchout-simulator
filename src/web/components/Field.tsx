import { cloneElement, useId, type ReactElement, type ReactNode } from "react";

/**
 * A `.form-row` whose label is programmatically associated with its single
 * child control (input/select/textarea) via htmlFor/useId — screen readers
 * announce the label and clicking it focuses the control. Rows with several
 * controls under one label (credential pairs, extrinsic rows) instead put an
 * aria-label on each control.
 */
export function Field({
  label,
  children,
  after,
}: {
  label: ReactNode;
  children: ReactElement<{ id?: string }>;
  /** Optional content rendered after the control (hints, inline warnings). */
  after?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="form-row">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
      {after}
    </div>
  );
}
