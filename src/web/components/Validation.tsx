import type { ValidationResult } from "../types";

export function ValidationBadge({ validation }: { validation?: ValidationResult }) {
  if (!validation) return <span className="badge badge-muted">no validation</span>;
  const errors = validation.issues.filter((i) => i.severity === "error").length;
  const warnings = validation.issues.filter((i) => i.severity === "warning").length;
  if (!validation.wellFormed) return <span className="badge badge-error">not well-formed</span>;
  if (errors > 0) return <span className="badge badge-error">{errors} error{errors > 1 ? "s" : ""}</span>;
  if (warnings > 0) return <span className="badge badge-warn">{warnings} warning{warnings > 1 ? "s" : ""}</span>;
  return <span className="badge badge-ok">valid</span>;
}

/**
 * One line of chips for a whole exchange (request + response). Full panels
 * only appear for documents that actually have something to say — two
 * full-width green bars per exchange were pushing the real content down.
 */
export function ValidationSummary({ validations }: { validations: (ValidationResult | undefined)[] }) {
  const present = validations.filter((v): v is ValidationResult => !!v);
  if (present.length === 0) return null;
  const noisy = present.filter((v) => !v.wellFormed || v.issues.length > 0);
  return (
    <>
      <div className="validation-summary">
        <span className="validation-summary-label">Validation</span>
        {present.map((v) => (
          <span key={v.docType} className="vchip">
            <ValidationBadge validation={v} /> {v.docType}
          </span>
        ))}
      </div>
      {noisy.map((v) => (
        <ValidationPanel key={v.docType} validation={v} />
      ))}
    </>
  );
}

export function ValidationPanel({ validation }: { validation?: ValidationResult }) {
  if (!validation) return null;
  if (validation.issues.length === 0) {
    return (
      <div className="validation-panel">
        <div className="issue issue-ok">✓ No validation issues ({validation.docType})</div>
      </div>
    );
  }
  return (
    <div className="validation-panel">
      <div className="validation-head">
        Validation — {validation.docType} {validation.ok ? "(passes)" : "(has errors)"}
      </div>
      <ul className="issue-list">
        {validation.issues.map((issue, i) => (
          <li key={i} className={`issue issue-${issue.severity}`}>
            <span className="issue-sev">{issue.severity}</span>
            <span className="issue-code">{issue.code}</span>
            <span className="issue-msg">{issue.message}</span>
            {issue.path && <span className="issue-path">{issue.path}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
