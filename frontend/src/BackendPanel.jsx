import PhosphorIcon from './icons/PhosphorIcon.jsx';
import {ActivityEmptyState, ActivitySection} from './components/ActivitySection.jsx';
import {PROFILE_LIFECYCLE_COPY} from './lib/activity-profile.mjs';
import {useActivityProfile} from './lib/useActivityProfile.mjs';

export default function BackendPanel({address, lastAction, authenticated, authEnabled, onLogin, onConnect}) {
  const {state, busy, load, signIn, signOut, deleteProfile} = useActivityProfile({address, lastAction});
  const statusLabel = state.status === 'checking'
    ? 'Checking backend…'
    : state.status === 'online'
      ? 'Backend online'
      : 'Backend offline';

  let emptyState;
  if (state.status === 'checking') {
    emptyState = {icon: 'refresh', title: 'Checking activity service', description: 'Loading your off-chain activity status.'};
  } else if (state.status === 'offline') {
    emptyState = {icon: 'info', title: 'Activity service unavailable', description: state.message, action: {label: 'Retry', disabled: busy, onClick: load}};
  } else if (!authenticated) {
    emptyState = {icon: 'user', title: 'Sign in to view activity', description: 'Sign in to your RevMarket account before connecting a Stellar wallet.', action: {label: 'Sign in', disabled: !authEnabled, onClick: onLogin}};
  } else if (!address) {
    emptyState = {icon: 'wallet', title: 'Connect a Stellar wallet', description: 'Connect Freighter to create a wallet-scoped activity profile.', action: {label: 'Connect Freighter', disabled: busy, onClick: onConnect}};
  } else if (!state.profile) {
    emptyState = {icon: 'user', title: 'Activity profile not set up', description: 'Create an optional off-chain profile to review actions reported by this app.', action: {label: 'Enable activity profile', disabled: busy, onClick: signIn}};
  } else if (state.items.length === 0) {
    emptyState = {icon: 'pulse', title: 'No reported actions yet', description: 'Market actions reported by this app will appear here.', action: {label: 'Refresh', disabled: busy, onClick: load}};
  }

  return <ActivitySection id="activity-profile-title" title="Activity profile" icon="wallet" status={statusLabel}>
    <p className="activity-section-copy">{PROFILE_LIFECYCLE_COPY.signatureNotice}</p>
    {state.message && state.status === 'online' && <p className="form-error" role="alert">{state.message}</p>}
    {state.profile && <div className="activity-actions">
      <button className="icon-button" type="button" title="Refresh activity" aria-label="Refresh activity" disabled={busy} onClick={load}><PhosphorIcon name="refresh" /></button>
      <button className="button button-quiet button-small" type="button" disabled={busy} onClick={signOut}>Sign out of activity</button>
      <button className="button button-quiet button-small" type="button" disabled={busy} onClick={deleteProfile}>Delete off-chain profile</button>
    </div>}
    {emptyState && <ActivityEmptyState {...emptyState} />}
    {state.profile && state.items.length > 0 && <>
      <p className="activity-disclaimer">Reported by this app and not independently verified against the chain. Positions and payouts are read from the contract.</p>
      <ol className="activity-records">{state.items.slice(0, 5).map(item => <li key={item.id}><span>{item.action}</span><code>{item.txHash.slice(0, 12)}…</code></li>)}</ol>
    </>}
    {state.profile && <p className="activity-disclaimer">{PROFILE_LIFECYCLE_COPY.deletionScopeSummary}</p>}
  </ActivitySection>;
}
