import type { CartItem } from "../types";
import { addDays, isoDate, round3, splitEvenly, type Delivery, type Schedules } from "../schedule";

export type { Delivery, Schedules };

// Delivery schedules for the order: each cart line can be split into dated
// deliveries, sent as <ScheduleLine> elements on its ItemOut. A line with no
// schedule is delivered in one go, as before.

export function ScheduleEditor({
  items,
  schedules,
  onChange,
}: {
  items: CartItem[];
  schedules: Schedules;
  onChange: (next: Schedules) => void;
}) {
  const set = (line: number, deliveries: Delivery[] | undefined) => {
    const next = { ...schedules };
    if (!deliveries || deliveries.length === 0) delete next[line];
    else next[line] = deliveries;
    onChange(next);
  };
  const scheduledLines = Object.keys(schedules).length;

  return (
    <div className="attachments">
      <div className="attachments-head">
        <strong>Delivery schedule</strong>
        <span className="hint">
          {scheduledLines === 0 ? "Every line is delivered in one go" : `${scheduledLines} of ${items.length} lines scheduled`}
        </span>
      </div>
      <ul className="att-list">
        {items.map((it, i) => {
          const deliveries = schedules[i];
          const scheduled = round3((deliveries ?? []).reduce((sum, d) => sum + (Number.isFinite(d.quantity) ? d.quantity : 0), 0));
          const complete = Math.abs(scheduled - it.quantity) < 1e-6;
          const update = (j: number, patch: Partial<Delivery>) => set(i, deliveries!.map((d, k) => (k === j ? { ...d, ...patch } : d)));
          return (
            <li key={i} className="schedule-line">
              <div className="schedule-head">
                <span>
                  <code>{it.supplierPartId}</code> {it.description} <span className="hint">{it.quantity} {it.uom}</span>
                </span>
                {!deliveries ? (
                  <button className="btn-link" onClick={() => set(i, splitEvenly(it.quantity, 2))}>
                    Schedule deliveries
                  </button>
                ) : (
                  <span className={complete ? "hint" : "hint warn-hint"}>
                    {complete ? `all ${it.quantity} scheduled` : `${scheduled} of ${it.quantity} scheduled`}
                  </span>
                )}
              </div>
              {deliveries && (
                <>
                  {deliveries.map((d, j) => (
                    <div className="charge-row delivery" key={j}>
                      <span className="charge-label">Delivery {j + 1}</span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        aria-label={`Line ${i + 1} delivery ${j + 1} quantity`}
                        value={Number.isFinite(d.quantity) ? d.quantity : ""}
                        onChange={(e) => update(j, { quantity: e.target.value === "" ? NaN : Number(e.target.value) })}
                      />
                      <input type="date" aria-label={`Line ${i + 1} delivery ${j + 1} date`} value={d.date} onChange={(e) => update(j, { date: e.target.value })} />
                      <button className="btn-link" onClick={() => set(i, deliveries.filter((_, k) => k !== j))}>
                        remove
                      </button>
                    </div>
                  ))}
                  <div className="schedule-actions">
                    <button
                      className="btn-link"
                      onClick={() =>
                        set(i, [
                          ...deliveries,
                          { quantity: Math.max(0, round3(it.quantity - scheduled)), date: addDays(deliveries[deliveries.length - 1]?.date ?? isoDate(new Date()), 7) },
                        ])
                      }
                    >
                      + Add delivery
                    </button>
                    {[2, 3, 4].map((n) => (
                      <button key={n} className="btn-link" onClick={() => set(i, splitEvenly(it.quantity, n))} title={`Split ${it.quantity} evenly into ${n} weekly deliveries`}>
                        split in {n}
                      </button>
                    ))}
                    <button className="btn-link" onClick={() => set(i, undefined)}>
                      deliver in one go
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
