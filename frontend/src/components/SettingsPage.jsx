import {useEffect, useRef, useState} from 'react';
import {Link} from 'react-router-dom';
import {formatShortAddress, validateReviewerWallet} from '../lib/backend.mjs';
import {
  REVOCATION_EFFECTS,
  createAdminSettingsController,
  formatAuditTimestamp,
  isAdminAuthorizedForWallet,
  partitionReviewers,
} from '../lib/admin-settings.mjs';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';

const shortAddress = address => formatShortAddress(address, 8, 6);

export default function SettingsPage({address, busy, authenticated, authEnabled, user, contractId, rpcUrl, onLogin, onLogout, onConnect, onDisconnect}) {
  const controllerRef = useRef(null);
  if (!controllerRef.current) {
    controllerRef.current = createAdminSettingsController({initialAddress: address});
  }
  const [adminState, setAdminState] = useState(() => controllerRef.current.getState());
  const [walletInput, setWalletInput] = useState('');
  const [inputError, setInputError] = useState('');
  const email = user?.email?.address;
  const rpcHost = (() => {try {return new URL(rpcUrl).host;} catch {return 'Configured RPC';}})();

  useEffect(() => {
    const controller = controllerRef.current;
    const unsubscribe = controller.subscribe(setAdminState);
    setAdminState(controller.getState());
    return () => {
      unsubscribe();
      controller.abortInFlight();
    };
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    controller.setAddress(address);
    setWalletInput('');
    setInputError('');
    if (address) {
      controller.restoreSession();
    }
    return () => {
      controller.abortInFlight();
    };
  }, [address]);

  const isAuthorized = isAdminAuthorizedForWallet(adminState, address);
  const isMutating = Boolean(adminState.mutatingAction);
  const {active: activeReviewers, revoked: revokedReviewers} = partitionReviewers(adminState.reviewers);
  const orderedReviewers = [...activeReviewers, ...revokedReviewers];
  const trimmedInput = walletInput.trim();
  const matchingRevokedInput = Boolean(
    trimmedInput &&
    revokedReviewers.some(item => item.wallet === trimmedInput),
  );

  const adminStatusLabel = isAuthorized
    ? 'Super admin'
    : adminState.status === 'denied'
      ? 'Not authorized'
      : adminState.status === 'expired'
        ? 'Session expired'
        : 'Not verified';
  const adminMessageIsAlert = adminState.status === 'error' || adminState.status === 'expired';

  async function handleVerifySuperAdmin() {
    if (!address || adminState.verifying) return;
    await controllerRef.current.verifySuperAdmin();
  }

  async function handleRefreshReviewers() {
    await controllerRef.current.refreshReviewers();
  }

  async function handleAddReviewer(event) {
    event.preventDefault();
    const validation = validateReviewerWallet(walletInput);
    if (!validation.valid) {
      setInputError(validation.error);
      return;
    }
    setInputError('');
    const result = await controllerRef.current.addReviewer(validation.wallet);
    if (result?.ok) {
      setWalletInput('');
      setInputError('');
    }
  }

  async function handleReAddReviewer(wallet) {
    setInputError('');
    await controllerRef.current.addReviewer(wallet);
  }

  function handleRequestRevoke(wallet) {
    controllerRef.current.requestRevoke(wallet);
  }

  function handleCancelRevoke() {
    controllerRef.current.cancelRevoke();
  }

  async function handleConfirmRevoke() {
    await controllerRef.current.confirmRevoke();
  }

  return <div className="settings-page">
    <div className="page-heading"><div><p className="eyebrow">PREFERENCES & SECURITY</p><h1>Settings</h1></div></div>
    <section className="settings-section"><div className="settings-section-heading"><div><p className="eyebrow">ACCOUNT</p><h2>RevMarket sign-in</h2><p>Privy keeps your app account separate from Stellar transaction approvals.</p></div><span className={`settings-state${authenticated ? ' is-active' : ''}`}>{authenticated ? 'Signed in' : 'Not signed in'}</span></div><div className="settings-detail-row"><span>Email</span><strong>{email || 'No email linked'}</strong></div><div className="settings-detail-row"><span>Authentication</span><strong>{authEnabled ? 'Privy email and web3 wallet' : 'Unavailable'}</strong></div>{authenticated ? <button className="button button-secondary" onClick={() => onLogout?.()}>Sign out</button> : <button className="button button-secondary" disabled={!authEnabled} onClick={() => onLogin?.()}>Sign in</button>}</section>
    <section className="settings-section"><div className="settings-section-heading"><div><p className="eyebrow">STELLAR WALLET</p><h2>Transaction account</h2><p>Freighter signs transactions on Stellar Testnet. Sign in to RevMarket before connecting; Privy login does not authorize spending.</p></div><span className={`settings-state${address ? ' is-active' : ''}`}>{address ? 'Connected' : 'Disconnected'}</span></div><div className="settings-detail-row"><span>Address</span><strong>{address ? shortAddress(address) : 'No Freighter account connected'}</strong></div>{address ? <button className="button button-secondary" disabled={busy} onClick={onDisconnect}>Disconnect Freighter</button> : authenticated && <button className="button button-secondary" disabled={busy} onClick={onConnect}>Connect Freighter</button>}</section>
    <section className="settings-section">
      <div className="settings-section-heading">
        <div>
          <p className="eyebrow">ACTIVITY PROFILE</p>
          <h2>Off-chain activity session</h2>
          <p>{PROFILE_LIFECYCLE_COPY.signatureNotice}</p>
        </div>
        <span className={`settings-state${profileState.profile ? ' is-active' : ''}`}>{profileBadge}</span>
      </div>
      <div className="settings-detail-row"><span>Backend service</span><strong>{profileState.status === 'checking' ? 'Checking…' : profileState.status === 'online' ? 'Online' : 'Offline'}</strong></div>
      <div className="settings-detail-row"><span>Profile wallet</span><strong>{profileState.profile ? shortAddress(profileState.profile.wallet) : 'No active off-chain session'}</strong></div>
      <div className="settings-detail-row"><span>Private reports</span><strong>{profileState.profile ? `${profileState.items.length} reported ${profileState.items.length === 1 ? 'action' : 'actions'}` : 'None'}</strong></div>
      <p className="form-note">{PROFILE_LIFECYCLE_COPY.deletionScopeSummary}</p>
      {profileState.message && <p className="form-error" role="alert">{profileState.message}</p>}
      <div className="activity-actions">
        {profileState.status === 'offline' && <button className="button button-secondary" type="button" disabled={profileBusy} onClick={refreshProfile}>Retry</button>}
        {profileState.status === 'online' && address && !profileState.profile && <button className="button button-secondary" type="button" disabled={profileBusy} onClick={enableProfile}>Enable activity profile</button>}
        {profileState.status === 'online' && profileState.profile && <>
          <button className="button button-secondary" type="button" disabled={profileBusy} onClick={refreshProfile}>Refresh</button>
          <button className="button button-quiet button-small" type="button" disabled={profileBusy} onClick={signOutProfile}>Sign out of activity</button>
          <button className="button button-quiet button-small" type="button" disabled={profileBusy} onClick={deleteProfile}>Delete off-chain profile</button>
        </>}
      </div>
    </section>
    <section className="settings-section"><div className="settings-section-heading"><div><p className="eyebrow">NETWORK</p><h2>Stellar Testnet</h2><p>Market creation and positions use the configured Soroban contract.</p></div><span className="settings-state is-active">Testnet</span></div><div className="settings-detail-row"><span>RPC host</span><strong>{rpcHost}</strong></div><div className="settings-detail-row"><span>Contract</span><strong>{contractId || 'Not configured'}</strong></div><div className="settings-detail-row"><span>Market status</span><strong>{contractId ? 'Reading from contract' : 'Read-only: no contract configured'}</strong></div></section>
    <section className="settings-section">
      <div className="settings-section-heading">
        <div>
          <p className="eyebrow">ADMINISTRATOR</p>
          <h2>Network and reviewer access</h2>
          <p>Super-admin access is verified against the active wallet session and server-side wallet allowlist.</p>
        </div>
        <span className={`settings-state${isAuthorized ? ' is-active' : ''}`}>{adminStatusLabel}</span>
      </div>
      <button
        type="button"
        className="button button-secondary"
        disabled={!address || adminState.verifying}
        onClick={handleVerifySuperAdmin}
      >
        {adminState.verifying ? 'Verifying wallet…' : isAuthorized ? 'Refresh admin access' : 'Verify super-admin access'}
      </button>
      {adminState.message && (
        <p className={adminMessageIsAlert ? 'form-error' : 'form-note'} role={adminMessageIsAlert ? 'alert' : 'status'}>
          {adminState.message}
        </p>
      )}
      {isAuthorized && (
        <>
          <div className="network-switch" role="group" aria-label="Select Stellar network">
            <button type="button" className="is-active" aria-pressed="true">Testnet</button>
            <button
              type="button"
              disabled={!adminState.access.networks.mainnet.available}
              title={adminState.access.networks.mainnet.reason}
              aria-pressed="false"
            >
              Mainnet
            </button>
          </div>
          <p className="form-note">{adminState.access.networks.mainnet.reason}</p>

          <div className="admin-reviewers" aria-label="Reviewer wallet management">
            <div className="admin-reviewers-header">
              <div>
                <p className="eyebrow">REVIEWER ACCESS</p>
                <h3>Reviewer wallets</h3>
                <p className="form-note">Grant, revoke, or restore review permissions for submitted market drafts.</p>
              </div>
              <div className="admin-reviewers-toolbar">
                <span className="settings-state">
                  {activeReviewers.length} active · {revokedReviewers.length} revoked
                </span>
                <button
                  type="button"
                  className="button button-quiet button-small"
                  disabled={isMutating}
                  onClick={handleRefreshReviewers}
                >
                  <PhosphorIcon name="refresh" size={14} />
                  <span>{adminState.mutatingAction === 'refresh' ? 'Refreshing…' : 'Refresh'}</span>
                </button>
              </div>
            </div>

            <form className="reviewer-add-form" onSubmit={handleAddReviewer} noValidate>
              <label htmlFor="reviewer-wallet-input">Reviewer Stellar G-address</label>
              <div className="reviewer-add-controls">
                <input
                  id="reviewer-wallet-input"
                  name="reviewerWallet"
                  type="text"
                  value={walletInput}
                  onChange={event => {
                    setWalletInput(event.target.value);
                    if (inputError) setInputError('');
                  }}
                  placeholder="G..."
                  spellCheck={false}
                  autoComplete="off"
                  disabled={isMutating}
                  aria-invalid={Boolean(inputError)}
                  aria-describedby={inputError ? 'reviewer-wallet-error' : 'reviewer-wallet-hint'}
                />
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={isMutating}
                >
                  {adminState.mutatingAction === 'add' && adminState.mutatingWallet === trimmedInput
                    ? 'Saving…'
                    : matchingRevokedInput
                      ? 'Re-add reviewer'
                      : 'Add reviewer'}
                </button>
              </div>
              {inputError ? (
                <p id="reviewer-wallet-error" className="form-error" role="alert">{inputError}</p>
              ) : (
                <p id="reviewer-wallet-hint" className="form-note">
                  {matchingRevokedInput
                    ? 'This wallet was previously revoked. Submitting will re-enable reviewer access.'
                    : 'Enter a valid 56-character Stellar Ed25519 public key (G-address). Updates are persisted and audited.'}
                </p>
              )}
            </form>

            {adminState.feedback && (
              adminState.feedback.type === 'error' ? (
                <p className="form-error" role="alert">{adminState.feedback.message}</p>
              ) : (
                <p className="reviewer-feedback-success" role="status">
                  <PhosphorIcon name="check" size={14} />
                  <span>{adminState.feedback.message}</span>
                </p>
              )
            )}

            {adminState.pendingRevokeWallet && (
              <div className="reviewer-revoke-confirm" role="region" aria-label="Confirm reviewer revocation">
                <div className="reviewer-revoke-confirm-head">
                  <PhosphorIcon name="info" size={16} />
                  <strong>Confirm reviewer revocation</strong>
                </div>
                <p className="form-note">
                  You are about to revoke reviewer access for{' '}
                  <code className="reviewer-address-code">{adminState.pendingRevokeWallet}</code>:
                </p>
                <ul className="reviewer-revoke-effects">
                  {REVOCATION_EFFECTS.map(effect => <li key={effect}>{effect}</li>)}
                </ul>
                <div className="reviewer-revoke-actions">
                  <button
                    type="button"
                    className="button button-danger button-small"
                    disabled={isMutating}
                    onClick={handleConfirmRevoke}
                  >
                    {adminState.mutatingAction === 'revoke' ? 'Revoking…' : 'Confirm revoke'}
                  </button>
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    disabled={isMutating}
                    onClick={handleCancelRevoke}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {adminState.reviewersStatus === 'loading' && orderedReviewers.length === 0 ? (
              <p className="form-note" role="status">Loading reviewer wallets…</p>
            ) : adminState.reviewersStatus === 'error' && orderedReviewers.length === 0 ? (
              <div className="reviewer-empty-state">
                <p className="form-error" role="alert">{adminState.reviewersError || 'Could not load reviewer wallets.'}</p>
                <button type="button" className="button button-secondary button-small" disabled={isMutating} onClick={handleRefreshReviewers}>
                  Retry
                </button>
              </div>
            ) : orderedReviewers.length === 0 ? (
              <p className="form-note">No reviewer wallets configured yet. Add a Stellar G-address above to grant review access.</p>
            ) : (
              <ul className="reviewer-list">
                {orderedReviewers.map(reviewer => {
                  const isActiveReviewer = reviewer.revokedAt == null;
                  const isPendingRevoke = adminState.pendingRevokeWallet === reviewer.wallet;
                  const isRowReAdding = adminState.mutatingAction === 'add' && adminState.mutatingWallet === reviewer.wallet;
                  return (
                    <li
                      key={reviewer.wallet}
                      className={`reviewer-row${isActiveReviewer ? '' : ' is-revoked'}${isPendingRevoke ? ' is-pending-revoke' : ''}`}
                    >
                      <div className="reviewer-row-main">
                        <div className="reviewer-row-top">
                          <span className={`settings-state${isActiveReviewer ? ' is-active' : ' is-revoked'}`}>
                            {isActiveReviewer ? 'Active' : 'Revoked'}
                          </span>
                          <code className="reviewer-address-code">{reviewer.wallet}</code>
                        </div>
                        <div className="reviewer-row-meta">
                          <span title={reviewer.addedBy}>Added by {shortAddress(reviewer.addedBy)}</span>
                          <span>Added {formatAuditTimestamp(reviewer.addedAt)}</span>
                          {!isActiveReviewer && <span>Revoked {formatAuditTimestamp(reviewer.revokedAt)}</span>}
                        </div>
                      </div>
                      <div className="reviewer-row-actions">
                        {isActiveReviewer ? (
                          <button
                            type="button"
                            className="button button-danger-outline button-small"
                            disabled={isMutating || isPendingRevoke}
                            onClick={() => handleRequestRevoke(reviewer.wallet)}
                          >
                            {isPendingRevoke ? 'Confirm above' : 'Revoke'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="button button-secondary button-small"
                            disabled={isMutating}
                            onClick={() => handleReAddReviewer(reviewer.wallet)}
                          >
                            {isRowReAdding ? 'Re-adding…' : 'Re-add'}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
    <section className="settings-section"><div className="settings-section-heading"><div><p className="eyebrow">MARKET DATA</p><h2>Price charts</h2><p>Price-market detail charts use 5-minute, hourly, or 6-hour USD candles fetched directly from Coinbase. Event markets show live on-chain pool shares instead of simulated history.</p></div><span className="settings-state is-active">Live source</span></div><div className="settings-detail-row"><span>Supported assets</span><strong>BTC · ETH · XLM</strong></div><div className="settings-detail-row"><span>Refresh interval</span><strong>60 seconds</strong></div></section>
    <section className="settings-section settings-links"><div className="settings-section-heading"><div><p className="eyebrow">POLICIES</p><h2>Account and protocol information</h2></div></div><Link to="/privacy">Privacy policy <PhosphorIcon name="arrowRight" size={14} /></Link><Link to="/risk">Risk disclosure <PhosphorIcon name="arrowRight" size={14} /></Link><Link to="/terms">Terms of use <PhosphorIcon name="arrowRight" size={14} /></Link></section>
  </div>;
}
