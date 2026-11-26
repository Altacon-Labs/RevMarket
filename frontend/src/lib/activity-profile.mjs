import {api} from './backend.mjs';

export const PROFILE_LIFECYCLE_COPY = Object.freeze({
  signatureNotice:
    'A message signature proves control of your public signing key for this off-chain session. It does not authorize transactions, spending or automation. No email, password or private key is requested.',
  deletionScopeSummary:
    'Deleting your off-chain profile removes your backend wallet profile, active API session, and private app-reported activity list. It does not sign out or delete your Privy account, retained creator/review workflow records (drafts, reviews, audit logs), or public on-chain positions and transactions.',
  deleteConfirmMessage:
    'Delete this off-chain profile, active backend API session, and private app-reported activity list?\n\nYour Privy sign-in, retained creator/review workflow records, and public on-chain positions and transactions will remain unchanged.',
  offlineMessage:
    'The local backend could not be reached. Start it to use off-chain activity tracking.',
});

export async function loadActivityProfileState({address, apiClient = api} = {}) {
  try {
    await apiClient('/health');
    let profile = null;
    let items = [];
    if (address) {
      try {
        const me = await apiClient('/me');
        if (me?.wallet === address) {
          profile = me;
          const activity = await apiClient('/activity');
          items = Array.isArray(activity?.items) ? activity.items : [];
        }
      } catch (error) {
        if (error?.status !== 401) throw error;
      }
    }
    return {status: 'online', profile, items, message: ''};
  } catch {
    return {
      status: 'offline',
      profile: null,
      items: [],
      message: PROFILE_LIFECYCLE_COPY.offlineMessage,
    };
  }
}

export async function signOutActivityProfile({apiClient = api} = {}) {
  await apiClient('/logout', {method: 'POST'});
  return {status: 'online', profile: null, items: [], message: ''};
}

export async function deleteActivityProfile({
  apiClient = api,
  confirm = message => (typeof window !== 'undefined' ? window.confirm(message) : false),
} = {}) {
  if (!confirm(PROFILE_LIFECYCLE_COPY.deleteConfirmMessage)) {
    return {cancelled: true, deleted: false};
  }
  const result = await apiClient('/me', {method: 'DELETE'});
  return {
    cancelled: false,
    deleted: Boolean(result?.deleted ?? true),
    onChainDataUnchanged: Boolean(result?.onChainDataUnchanged ?? true),
    nextState: {status: 'online', profile: null, items: [], message: ''},
  };
}
