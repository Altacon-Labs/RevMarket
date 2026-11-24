import {
  addAdminReviewer,
  formatShortAddress,
  getAdminNetwork,
  getCurrentSession,
  listAdminReviewers,
  revokeAdminReviewer,
  signInActivity,
  validateReviewerWallet,
} from './backend.mjs';

export const REVOCATION_EFFECTS = Object.freeze([
  'Immediately removes reviewer access to the draft review queue and review decisions.',
  'Reverts any approved market drafts approved by this reviewer back to draft status.',
  'Invalidates pending publication intents backed by this reviewer with reason reviewer_revoked.',
  'Records a reviewer_revoked audit event. The wallet can be re-added later if needed.',
]);

export function formatAuditTimestamp(unixSeconds) {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return 'Unknown time';
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function partitionReviewers(reviewers = []) {
  const active = [];
  const revoked = [];
  for (const reviewer of reviewers) {
    if (reviewer && reviewer.revokedAt == null) active.push(reviewer);
    else if (reviewer) revoked.push(reviewer);
  }
  return {active, revoked};
}

export function isAdminAuthorizedForWallet(state, address) {
  return Boolean(
    address &&
    state &&
    state.status === 'authorized' &&
    state.verifiedWallet === address &&
    state.access?.role === 'super_admin'
  );
}

export function createInitialAdminState(address = '') {
  return {
    address: typeof address === 'string' ? address : '',
    status: 'unverified',
    verifiedWallet: null,
    access: null,
    message: '',
    verifying: false,
    reviewers: [],
    reviewersStatus: 'idle',
    reviewersError: '',
    mutatingAction: null,
    mutatingWallet: null,
    pendingRevokeWallet: null,
    feedback: null,
  };
}

function isAbortError(error) {
  return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
}

export function createAdminSettingsController({
  initialAddress = '',
  getSession = getCurrentSession,
  getNetwork = getAdminNetwork,
  getReviewers = listAdminReviewers,
  addReviewerApi = addAdminReviewer,
  revokeReviewerApi = revokeAdminReviewer,
  signIn = signInActivity,
} = {}) {
  let state = createInitialAdminState(initialAddress);
  let walletEpoch = 0;
  const listeners = new Set();
  const inFlight = new Set();
  let restoreController = null;

  function emit(nextState) {
    state = nextState;
    for (const listener of listeners) listener(state);
  }

  function patch(partial) {
    emit({...state, ...partial});
  }

  function abortController(controller) {
    if (!controller) return;
    inFlight.delete(controller);
    try {
      if (!controller.signal.aborted) controller.abort();
    } catch {}
  }

  function abortAllInFlight() {
    for (const controller of Array.from(inFlight)) {
      abortController(controller);
    }
    restoreController = null;
  }

  function startRequest(trackAsRestore = false) {
    const epoch = walletEpoch;
    const expectedWallet = state.address;
    const controller = new AbortController();
    inFlight.add(controller);
    if (trackAsRestore) {
      if (restoreController) abortController(restoreController);
      restoreController = controller;
    }
    const isCurrent = () =>
      epoch === walletEpoch &&
      state.address === expectedWallet &&
      !controller.signal.aborted;
    const finish = () => {
      inFlight.delete(controller);
      if (restoreController === controller) restoreController = null;
    };
    return {wallet: expectedWallet, signal: controller.signal, isCurrent, finish};
  }

  function clearProtectedState(status, message) {
    patch({
      status,
      verifiedWallet: null,
      access: null,
      message,
      reviewers: [],
      reviewersStatus: 'idle',
      reviewersError: '',
      mutatingAction: null,
      mutatingWallet: null,
      pendingRevokeWallet: null,
      feedback: null,
    });
  }

  async function syncReviewersSilently(req, preserveFeedback) {
    try {
      const reviewers = await getReviewers({signal: req.signal});
      if (!req.isCurrent()) return;
      patch({
        reviewers,
        reviewersStatus: 'loaded',
        reviewersError: '',
        feedback: preserveFeedback,
      });
    } catch (syncError) {
      if (!req.isCurrent() || isAbortError(syncError)) return;
      if (syncError.status === 401) {
        clearProtectedState('expired', 'Your administrator session expired. Verify super-admin access again.');
      } else if (syncError.status === 403) {
        clearProtectedState('denied', 'This wallet is not in the server super-admin allowlist.');
      }
    }
  }

  return {
    getState() {
      return state;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setAddress(nextAddress) {
      const normalized = typeof nextAddress === 'string' ? nextAddress : '';
      if (normalized === state.address) return;
      walletEpoch += 1;
      abortAllInFlight();
      emit(createInitialAdminState(normalized));
    },

    abortInFlight() {
      walletEpoch += 1;
      abortAllInFlight();
    },

    dispose() {
      walletEpoch += 1;
      abortAllInFlight();
      listeners.clear();
    },

    async restoreSession() {
      if (!state.address || state.verifying) return {ok: false, reason: 'unavailable'};
      const req = startRequest(true);
      let networkAuthorized = false;
      try {
        const me = await getSession({signal: req.signal});
        if (!req.isCurrent()) return {ok: false, stale: true};
        if (!me || me.wallet !== req.wallet) {
          return {ok: false, reason: 'session_mismatch'};
        }

        const access = await getNetwork({signal: req.signal});
        if (!req.isCurrent()) return {ok: false, stale: true};
        if (!access || access.role !== 'super_admin') {
          return {ok: false, reason: 'not_super_admin'};
        }

        networkAuthorized = true;
        patch({
          status: 'authorized',
          verifiedWallet: req.wallet,
          access,
          message: '',
          reviewersStatus: 'loading',
          reviewersError: '',
        });

        const reviewers = await getReviewers({signal: req.signal});
        if (!req.isCurrent()) return {ok: false, stale: true};
        patch({
          reviewers,
          reviewersStatus: 'loaded',
          reviewersError: '',
        });
        return {ok: true, access, reviewers};
      } catch (error) {
        if (!req.isCurrent() || isAbortError(error)) return {ok: false, stale: true};
        if (networkAuthorized) {
          if (error.status === 401) {
            clearProtectedState('expired', 'Your administrator session expired. Verify super-admin access again.');
          } else if (error.status === 403) {
            clearProtectedState('denied', 'This wallet is not in the server super-admin allowlist.');
          } else {
            patch({
              reviewers: [],
              reviewersStatus: 'error',
              reviewersError: error.message || 'Could not load reviewer wallets.',
            });
          }
        }
        return {ok: false, error};
      } finally {
        req.finish();
      }
    },

    async verifySuperAdmin() {
      if (!state.address || state.verifying) return {ok: false, reason: 'unavailable'};
      if (restoreController) abortController(restoreController);

      const req = startRequest(false);
      let networkAuthorized = false;
      patch({verifying: true, message: ''});

      try {
        let me = null;
        try {
          me = await getSession({signal: req.signal});
        } catch (error) {
          if (error.status !== 401) throw error;
        }
        if (!req.isCurrent()) return {ok: false, stale: true};

        if (!me || me.wallet !== req.wallet) {
          const signed = await signIn(req.wallet, req.isCurrent);
          if (!req.isCurrent()) return {ok: false, stale: true};
          if (signed?.wallet && signed.wallet !== req.wallet) {
            throw new Error('Signed session wallet does not match the connected wallet.');
          }
        }

        const access = await getNetwork({signal: req.signal});
        if (!req.isCurrent()) return {ok: false, stale: true};
        if (!access || access.role !== 'super_admin') {
          const deniedError = new Error('Super-admin access required');
          deniedError.status = 403;
          throw deniedError;
        }

        networkAuthorized = true;
        patch({
          status: 'authorized',
          verifiedWallet: req.wallet,
          access,
          message: '',
          reviewersStatus: 'loading',
          reviewersError: '',
          pendingRevokeWallet: null,
          feedback: null,
        });

        const reviewers = await getReviewers({signal: req.signal});
        if (!req.isCurrent()) return {ok: false, stale: true};
        patch({
          reviewers,
          reviewersStatus: 'loaded',
          reviewersError: '',
        });
        return {ok: true, access, reviewers};
      } catch (error) {
        if (!req.isCurrent() || isAbortError(error)) return {ok: false, stale: true};
        if (error.status === 403) {
          clearProtectedState('denied', 'This wallet is not in the server super-admin allowlist.');
        } else if (error.status === 401) {
          clearProtectedState('expired', 'Your administrator session expired. Verify super-admin access again.');
        } else if (networkAuthorized) {
          patch({
            reviewers: [],
            reviewersStatus: 'error',
            reviewersError: error.message || 'Could not load reviewer wallets.',
          });
        } else {
          clearProtectedState('error', error.message || 'Super-admin verification failed.');
        }
        return {ok: false, error};
      } finally {
        req.finish();
        if (req.isCurrent()) patch({verifying: false});
      }
    },

    async refreshReviewers() {
      if (!isAdminAuthorizedForWallet(state, state.address) || state.mutatingAction) {
        return {ok: false, reason: 'unavailable'};
      }
      const req = startRequest(false);
      patch({
        mutatingAction: 'refresh',
        mutatingWallet: null,
        reviewersError: '',
        feedback: null,
      });

      try {
        const reviewers = await getReviewers({signal: req.signal});
        if (!req.isCurrent()) return {ok: false, stale: true};
        patch({
          reviewers,
          reviewersStatus: 'loaded',
          reviewersError: '',
        });
        return {ok: true, reviewers};
      } catch (error) {
        if (!req.isCurrent() || isAbortError(error)) return {ok: false, stale: true};
        if (error.status === 401) {
          clearProtectedState('expired', 'Your administrator session expired. Verify super-admin access again.');
        } else if (error.status === 403) {
          clearProtectedState('denied', 'This wallet is not in the server super-admin allowlist.');
        } else {
          const message = error.message || 'Could not refresh reviewer wallets.';
          patch({
            reviewersStatus: state.reviewersStatus === 'loaded' ? 'loaded' : 'error',
            reviewersError: message,
            feedback: {type: 'error', message},
          });
        }
        return {ok: false, error};
      } finally {
        req.finish();
        if (req.isCurrent()) patch({mutatingAction: null, mutatingWallet: null});
      }
    },

    async addReviewer(rawWallet) {
      if (!isAdminAuthorizedForWallet(state, state.address) || state.mutatingAction) {
        return {ok: false, reason: 'unavailable'};
      }
      const validation = validateReviewerWallet(rawWallet);
      if (!validation.valid) {
        patch({feedback: {type: 'error', message: validation.error}});
        return {ok: false, reason: 'invalid_wallet', error: validation.error};
      }

      const targetWallet = validation.wallet;
      const wasRevoked = state.reviewers.some(
        item => item.wallet === targetWallet && item.revokedAt != null,
      );
      const req = startRequest(false);
      let mutationSucceeded = false;

      patch({
        mutatingAction: 'add',
        mutatingWallet: targetWallet,
        feedback: null,
      });

      try {
        await addReviewerApi(targetWallet, {signal: req.signal});
        if (!req.isCurrent()) return {ok: false, stale: true};
        mutationSucceeded = true;

        const reviewers = await getReviewers({signal: req.signal});
        if (!req.isCurrent()) return {ok: false, stale: true};
        const persisted = reviewers.find(item => item.wallet === targetWallet && item.revokedAt == null);
        if (!persisted) {
          throw new Error('Reviewer update could not be confirmed in the refreshed reviewer list.');
        }

        patch({
          reviewers,
          reviewersStatus: 'loaded',
          reviewersError: '',
          pendingRevokeWallet: state.pendingRevokeWallet === targetWallet ? null : state.pendingRevokeWallet,
          feedback: {
            type: 'success',
            message: wasRevoked
              ? `Re-added reviewer ${formatShortAddress(targetWallet)}.`
              : `Added reviewer ${formatShortAddress(targetWallet)}.`,
          },
        });
        return {ok: true, reviewers, reAdded: wasRevoked};
      } catch (error) {
        if (!req.isCurrent() || isAbortError(error)) return {ok: false, stale: true};
        if (error.status === 401) {
          clearProtectedState(
            'expired',
            mutationSucceeded
              ? 'Reviewer change was submitted, but your administrator session expired before the list could refresh. Verify super-admin access to confirm persisted status.'
              : 'Your administrator session expired. Verify super-admin access again; no reviewer change was applied.',
          );
        } else if (error.status === 403) {
          clearProtectedState('denied', 'This wallet is not in the server super-admin allowlist.');
        } else if (error.status === 409) {
          const duplicateFeedback = {type: 'error', message: 'This wallet is already an active reviewer.'};
          patch({feedback: duplicateFeedback});
          await syncReviewersSilently(req, duplicateFeedback);
        } else if (mutationSucceeded) {
          const message = 'Reviewer change was submitted, but refreshing the reviewer list failed. Click Refresh to confirm persisted status.';
          patch({
            reviewersError: error.message || message,
            feedback: {type: 'error', message},
          });
        } else {
          patch({
            feedback: {
              type: 'error',
              message: error.message || 'Could not add reviewer wallet. Please try again.',
            },
          });
        }
        return {ok: false, error};
      } finally {
        req.finish();
        if (req.isCurrent()) patch({mutatingAction: null, mutatingWallet: null});
      }
    },

    requestRevoke(wallet) {
      if (!isAdminAuthorizedForWallet(state, state.address) || state.mutatingAction) return false;
      const validation = validateReviewerWallet(wallet);
      if (!validation.valid) return false;
      patch({pendingRevokeWallet: validation.wallet, feedback: null});
      return true;
    },

    cancelRevoke() {
      if (state.mutatingAction === 'revoke') return;
      patch({pendingRevokeWallet: null});
    },

    async confirmRevoke(walletOverride) {
      if (!isAdminAuthorizedForWallet(state, state.address) || state.mutatingAction) {
        return {ok: false, reason: 'unavailable'};
      }
      const target = walletOverride !== undefined ? walletOverride : state.pendingRevokeWallet;
      if (!target) {
        return {ok: false, reason: 'confirmation_required'};
      }
      const validation = validateReviewerWallet(target);
      if (!validation.valid) {
        patch({feedback: {type: 'error', message: validation.error}});
        return {ok: false, reason: 'invalid_wallet', error: validation.error};
      }

      const targetWallet = validation.wallet;
      const req = startRequest(false);
      let mutationSucceeded = false;

      patch({
        mutatingAction: 'revoke',
        mutatingWallet: targetWallet,
        feedback: null,
      });

      try {
        await revokeReviewerApi(targetWallet, {signal: req.signal});
        if (!req.isCurrent()) return {ok: false, stale: true};
        mutationSucceeded = true;

        const reviewers = await getReviewers({signal: req.signal});
        if (!req.isCurrent()) return {ok: false, stale: true};
        const persisted = reviewers.find(item => item.wallet === targetWallet && item.revokedAt != null);
        if (!persisted) {
          throw new Error('Reviewer revocation could not be confirmed in the refreshed reviewer list.');
        }

        patch({
          reviewers,
          reviewersStatus: 'loaded',
          reviewersError: '',
          pendingRevokeWallet: null,
          feedback: {
            type: 'success',
            message: `Revoked reviewer ${formatShortAddress(targetWallet)}. Approved drafts were reverted to draft and pending publication intents were invalidated.`,
          },
        });
        return {ok: true, reviewers};
      } catch (error) {
        if (!req.isCurrent() || isAbortError(error)) return {ok: false, stale: true};
        if (error.status === 401) {
          clearProtectedState(
            'expired',
            mutationSucceeded
              ? 'Reviewer revocation was submitted, but your administrator session expired before the list could refresh. Verify super-admin access to confirm persisted status.'
              : 'Your administrator session expired. Verify super-admin access again; no reviewer change was applied.',
          );
        } else if (error.status === 403) {
          clearProtectedState('denied', 'This wallet is not in the server super-admin allowlist.');
        } else if (error.status === 404) {
          const alreadyRevokedFeedback = {
            type: 'error',
            message: 'This reviewer was not found or has already been revoked.',
          };
          patch({pendingRevokeWallet: null, feedback: alreadyRevokedFeedback});
          await syncReviewersSilently(req, alreadyRevokedFeedback);
        } else if (mutationSucceeded) {
          const message = 'Reviewer revocation was submitted, but refreshing the reviewer list failed. Click Refresh to confirm persisted status.';
          patch({
            pendingRevokeWallet: null,
            reviewersError: error.message || message,
            feedback: {type: 'error', message},
          });
        } else {
          patch({
            feedback: {
              type: 'error',
              message: error.message || 'Could not revoke reviewer wallet. Please try again.',
            },
          });
        }
        return {ok: false, error};
      } finally {
        req.finish();
        if (req.isCurrent()) patch({mutatingAction: null, mutatingWallet: null});
      }
    },
  };
}
