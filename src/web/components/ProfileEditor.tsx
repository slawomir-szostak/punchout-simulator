import { useEffect, useState } from "react";
import type { DtdVersionMap, Profile, ProfileExtrinsic } from "../types";
import { api } from "../api";
import { Field } from "./Field";
import { Actions, useDraft, type SaveProps } from "./PartyEditors";

// Editor for a reusable procurement-platform Profile. A profile holds the
// platform-intrinsic defaults for the cXML a buyer running that platform emits
// (per-document-type DTD version, UserAgent, operation, transport, auth, and
// Extrinsic templates). A buyer references a profile; a connection's own
// attachmentEncoding still overrides it per pair.

const blankProfile = (): Partial<Profile> => ({
  name: "",
  platform: "",
  dtdVersions: { default: "1.2.045" },
  userAgent: "punchout-simulator",
  setupOperation: "create",
  attachmentEncoding: "binary",
  cartReturnTransport: "cxml-urlencoded",
  extrinsics: [],
  addressMode: "full",
  shipToInSetup: false,
  contactInSetup: false,
});

const DOC_TYPES: Array<keyof DtdVersionMap> = [
  "SetupRequest",
  "SetupResponse",
  "PunchOutOrderMessage",
  "OrderRequest",
  "OrderResponse",
];

export function ProfileEditor({ profile, onSave, onDelete }: { profile: Profile | null } & SaveProps) {
  const [draft, setDraft] = useDraft<Partial<Profile>>(profile ?? blankProfile(), profile?.id ?? "new");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [presets, setPresets] = useState<Profile[]>([]);

  useEffect(() => {
    api.listProfilePresets().then(setPresets).catch(() => setPresets([]));
  }, []);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onSave(draft);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const versions = draft.dtdVersions ?? { default: "1.2.045" };
  const setVersion = (key: keyof DtdVersionMap, value: string) => {
    const next: DtdVersionMap = { ...versions };
    if (key === "default") next.default = value;
    else if (value) (next as unknown as Record<string, string>)[key] = value;
    else delete (next as unknown as Record<string, string | undefined>)[key];
    setDraft({ ...draft, dtdVersions: next });
  };

  const extrinsics = draft.extrinsics ?? [];
  const setExtrinsic = (i: number, patch: Partial<ProfileExtrinsic>) =>
    setDraft({ ...draft, extrinsics: extrinsics.map((e, j) => (j === i ? { ...e, ...patch } : e)) });
  const addExtrinsic = () =>
    setDraft({ ...draft, extrinsics: [...extrinsics, { name: "", value: "", scope: "setup" }] });
  const removeExtrinsic = (i: number) =>
    setDraft({ ...draft, extrinsics: extrinsics.filter((_, j) => j !== i) });

  const loadPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    // Loading a preset overwrites the form fields. When editing an existing
    // profile (rather than creating a new one), confirm so hand-tuned values
    // aren't silently replaced.
    if (profile && !window.confirm(`Replace this profile's fields with the "${preset.name}" preset?`)) {
      return;
    }
    // Fill the form from the preset, but keep this row's own id/builtin flag so
    // we edit/create the current profile rather than the read-only library item.
    const { id: _id, builtin: _b, createdAt: _c, updatedAt: _u, ...fields } = preset;
    setDraft({ ...draft, ...fields });
  };

  return (
    <div className="editor-form">
      <p className="hint">
        A platform profile captures how a buyer's procurement system emits cXML. Assign it to a Buyer.
        Attachment encoding set on a Connection overrides the profile per pair.
      </p>

      <Field label={<>Load built-in preset <span className="hint">(fills the fields below — then customize)</span></>}>
        <select value="" onChange={(e) => e.target.value && loadPreset(e.target.value)}>
          <option value="">— choose a preset —</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </Field>

      <div className="form-grid">
        <Field label="Name">
          <input value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="My Coupa tenant" />
        </Field>
        <Field label={<>Platform <span className="hint">(label)</span></>}>
          <input value={draft.platform ?? ""} onChange={(e) => setDraft({ ...draft, platform: e.target.value })} placeholder="Coupa" />
        </Field>
      </div>

      <fieldset>
        <legend>cXML DTD versions <span className="hint">(per document type; blank = use default)</span></legend>
        <Field label="Default">
          <input value={versions.default} onChange={(e) => setVersion("default", e.target.value)} placeholder="1.2.045" />
        </Field>
        <div className="form-grid">
          {DOC_TYPES.map((dt) => (
            <Field label={dt} key={dt}>
              <input
                value={(versions as unknown as Record<string, string | undefined>)[dt] ?? ""}
                onChange={(e) => setVersion(dt, e.target.value)}
                placeholder={`(${versions.default})`}
              />
            </Field>
          ))}
        </div>
      </fieldset>

      <Field label="UserAgent">
        <input value={draft.userAgent ?? ""} onChange={(e) => setDraft({ ...draft, userAgent: e.target.value })} placeholder="Coupa Procurement" />
      </Field>

      <div className="form-grid">
        <Field label="Setup operation">
          <select value={draft.setupOperation ?? "create"} onChange={(e) => setDraft({ ...draft, setupOperation: e.target.value as any })}>
            <option value="create">create</option>
            <option value="edit">edit</option>
            <option value="inspect">inspect</option>
          </select>
        </Field>
        <Field label={<>Attachment encoding <span className="hint">(connection overrides)</span></>}>
          <select value={draft.attachmentEncoding ?? "binary"} onChange={(e) => setDraft({ ...draft, attachmentEncoding: e.target.value as any })}>
            <option value="binary">binary</option>
            <option value="base64">base64</option>
          </select>
        </Field>
        <Field label="Cart-return transport">
          <select value={draft.cartReturnTransport ?? "cxml-urlencoded"} onChange={(e) => setDraft({ ...draft, cartReturnTransport: e.target.value as any })}>
            <option value="cxml-urlencoded">cxml-urlencoded</option>
            <option value="cxml-base64">cxml-base64</option>
            <option value="raw">raw (text/xml body)</option>
          </select>
        </Field>
      </div>

      <fieldset>
        <legend>Addresses <span className="hint">(how ShipTo/BillTo/Contact are emitted)</span></legend>
        <Field label="Address mode">
          <select value={draft.addressMode ?? "full"} onChange={(e) => setDraft({ ...draft, addressMode: e.target.value as any })}>
            <option value="full">full — emit the PostalAddress</option>
            <option value="id-only">id-only — emit just addressID (reference)</option>
            <option value="both">both — addressID + PostalAddress</option>
          </select>
        </Field>
        <label className="check-row">
          <input type="checkbox" checked={!!draft.shipToInSetup} onChange={(e) => setDraft({ ...draft, shipToInSetup: e.target.checked })} />
          Send ShipTo in the PunchOutSetupRequest
          <span className="hint"> — Ariba-style; lets the supplier price/check per ship-to</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={!!draft.contactInSetup} onChange={(e) => setDraft({ ...draft, contactInSetup: e.target.checked })} />
          Send Contact in the PunchOutSetupRequest
        </label>
      </fieldset>

      <fieldset>
        <legend>Extrinsic templates <span className="hint">(injected into setup/order; value may use ${"{buyerCookie}"} / ${"{orderId}"})</span></legend>
        {extrinsics.length === 0 && <p className="hint">No extrinsics.</p>}
        {extrinsics.map((e, i) => (
          <div className="catalog-row" key={i}>
            <input placeholder="name" aria-label={`Extrinsic ${i + 1} name`} value={e.name} onChange={(ev) => setExtrinsic(i, { name: ev.target.value })} />
            <input placeholder="value" aria-label={`Extrinsic ${i + 1} value`} value={e.value} onChange={(ev) => setExtrinsic(i, { value: ev.target.value })} />
            <select aria-label={`Extrinsic ${i + 1} scope`} value={e.scope} onChange={(ev) => setExtrinsic(i, { scope: ev.target.value as any })}>
              <option value="setup">setup</option>
              <option value="order">order</option>
            </select>
            <button className="btn-link" onClick={() => removeExtrinsic(i)}>remove</button>
          </div>
        ))}
        <button className="btn-secondary" onClick={addExtrinsic}>+ Add extrinsic</button>
      </fieldset>

      {profile?.builtin && (
        <p className="hint">This is a built-in preset. Saving edits it in place; deleting removes it, but it will be re-created on the next start.</p>
      )}

      <Actions saving={saving} err={err} isNew={!profile} noun="profile" onSave={save} onError={setErr} onDelete={profile && onDelete ? () => onDelete(profile.id) : undefined} />
    </div>
  );
}
