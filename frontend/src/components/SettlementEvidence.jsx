import {useEffect, useRef, useState} from 'react';
import {MAX_EVIDENCE_BYTES, digestOfMarket, verifyEvidenceBytes} from '../lib/evidence-verify.mjs';

const FIELD_LABELS = {
  contractId: 'contract ID',
  marketId: 'market ID',
  question: 'question',
  closesAt: 'close time',
};

function outcomeText(market, settled, refundable) {
  if (refundable && !settled) return 'Refund path';
  if (!settled) return 'Pending settlement';
  if (market?.outcome === 0) return 'YES';
  if (market?.outcome === 1) return 'NO';
  return 'Not recorded';
}

function confidenceText(market, settled) {
  if (!settled) return 'Not available yet';
  const value = Number(market?.confidence);
  if (market?.confidence == null || !Number.isInteger(value)) return 'Not recorded';
  return `${(value / 100).toFixed(2)}%`;
}

function resultView(result) {
  switch (result?.status) {
    case 'ok':
      return {tone: 'ok', text: `Integrity verified. The file SHA-256 is ${result.digest} and its contract, market, question and close time all bind to this market.`};
    case 'integrity':
      return {tone: 'bad', text: `Integrity check failed. The file hashes to ${result.actual}, but the market records ${result.expected}. A single changed byte breaks this.`};
    case 'binding':
      return {tone: 'bad', text: `Binding check failed. The ${FIELD_LABELS[result.field] || result.field} in the file does not match this market.`};
    case 'malformed':
      return {tone: 'bad', text: 'The selected file is not valid UTF-8 JSON.'};
    case 'not-v1':
      return {tone: 'bad', text: `The selected file is not version-1 settlement evidence: ${result.reason}.`};
    case 'too-large':
      return {tone: 'bad', text: `The selected file is larger than the ${MAX_EVIDENCE_BYTES / 1024 / 1024} MiB limit.`};
    case 'empty':
      return {tone: 'bad', text: 'The selected file is empty.'};
    case 'unsupported':
      return {tone: 'bad', text: 'This browser cannot compute SHA-256 locally, so the file cannot be verified.'};
    case 'missing-digest':
      return {tone: 'bad', text: 'No on-chain evidence digest is recorded, so integrity cannot be checked.'};
    case 'zero-digest':
      return {tone: 'bad', text: 'The on-chain digest is an all-zero placeholder; treat this as no evidence.'};
    default:
      return {tone: 'bad', text: 'The selected file could not be read. Raw evidence was not uploaded anywhere.'};
  }
}

export default function SettlementEvidence({market, contractId, refundable = false}) {
  const [result, setResult] = useState(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    setResult(null);
    setFileName('');
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
  }, [market?.id]);

  const digest = digestOfMarket(market);
  const settled = market?.status === 2 && !refundable;

  async function selectFile(event) {
    const file = event.target.files?.[0];
    setResult(null);
    setFileName(file?.name || '');
    if (!file) return;
    if (file.size === 0) {
      setResult({status: 'empty'});
      return;
    }
    if (file.size > MAX_EVIDENCE_BYTES) {
      setResult({status: 'too-large'});
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setResult(await verifyEvidenceBytes({bytes, market, contractId}));
    } catch {
      setResult({status: 'read-error'});
    } finally {
      setBusy(false);
    }
  }

  const outcome = outcomeText(market, settled, refundable);
  const view = result ? resultView(result) : null;

  return (
    <section className="detail-panel settlement-evidence" data-testid="settlement-evidence" aria-labelledby="settlement-evidence-title">
      <p className="eyebrow">SETTLEMENT EVIDENCE</p>
      <h2 id="settlement-evidence-title">Outcome, digest and local verification</h2>

      <div className="settlement-evidence__facts">
        <div>
          <span>Outcome</span>
          <strong className="settlement-evidence__outcome">{outcome}</strong>
        </div>
        <div>
          <span>Confidence</span>
          <strong>{confidenceText(market, settled)}</strong>
        </div>
        <div>
          <span>On-chain digest</span>
          {digest.state === 'available' ? (
            <code className="settlement-evidence__digest">{digest.hex}</code>
          ) : digest.state === 'zero' ? (
            <strong>All-zero placeholder (no evidence recorded)</strong>
          ) : (
            <strong>Not recorded</strong>
          )}
        </div>
      </div>

      {refundable && !settled && (
        <p className="settlement-evidence__note" role="status">
          This market is refundable after its resolution deadline. The refund path does not require settlement evidence.
        </p>
      )}

      {!settled && !refundable && (
        <p className="settlement-evidence__note" role="status">
          This market has not settled yet. Evidence verification unlocks after settlement.
        </p>
      )}

      {settled && digest.state === 'available' && (
        <>
          <label className="evidence-file">
            <span>Select the exported v1 evidence JSON</span>
            <input ref={inputRef} type="file" accept=".json,application/json" onChange={selectFile} aria-describedby="evidence-file-help" />
          </label>
          <p id="evidence-file-help" className="settlement-evidence__note">
            The file is read in your browser with SHA-256 and never uploaded, fetched or opened automatically.
            {fileName ? <> Selected file: <strong>{fileName}</strong>.</> : null}
          </p>
          {busy && <p className="settlement-evidence__note" role="status">Verifying locally…</p>}
          {view && (
            <p className={`evidence-result is-${view.tone}`} role={view.tone === 'ok' ? 'status' : 'alert'}>
              {view.text}
            </p>
          )}
        </>
      )}

      {settled && digest.state !== 'available' && (
        <p className="evidence-result is-bad" role="alert">
          {digest.state === 'zero'
            ? 'The on-chain digest is an all-zero placeholder; treat this as no evidence. No file can verify against it.'
            : 'No on-chain evidence digest is recorded for this market, so a selected file cannot be verified.'}
        </p>
      )}

      <p className="settlement-evidence__disclaimer">
        Digest match verifies these bytes against the recorded commitment; it does not verify the outcome or source truthfulness.
      </p>
    </section>
  );
}
