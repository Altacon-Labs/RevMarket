import {useCallback, useEffect, useRef, useState} from 'react';
import {api, signInActivity} from './backend.mjs';
import {
  deleteActivityProfile,
  loadActivityProfileState,
  signOutActivityProfile,
} from './activity-profile.mjs';

export function useActivityProfile({address, lastAction = ''} = {}) {
  const [state, setState] = useState({status: 'checking', profile: null, items: [], message: ''});
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const activeAddress = useRef(address);
  activeAddress.current = address;

  const load = useCallback(async () => {
    const version = ++generation.current;
    const next = await loadActivityProfileState({address: activeAddress.current, apiClient: api});
    if (version === generation.current) setState(next);
    return next;
  }, []);

  useEffect(() => {
    setState(s => ({...s, profile: null, items: [], message: ''}));
    load();
    return () => {
      generation.current++;
    };
  }, [address, lastAction, load]);

  const run = useCallback(async action => {
    if (busy) return null;
    const expected = address;
    setBusy(true);
    try {
      const result = await action();
      if (activeAddress.current === expected && result?.reload !== false) {
        await load();
      }
      return result;
    } catch (error) {
      if (activeAddress.current === expected) {
        setState(s => ({...s, message: error?.message || 'Activity profile request failed.'}));
      }
      return null;
    } finally {
      setBusy(false);
    }
  }, [address, busy, load]);

  const signIn = useCallback(
    () => run(() => signInActivity(address, () => activeAddress.current === address)),
    [address, run],
  );

  const signOut = useCallback(
    () =>
      run(async () => {
        const next = await signOutActivityProfile({apiClient: api});
        setState(next);
        return {reload: true};
      }),
    [run],
  );

  const deleteProfile = useCallback(
    () =>
      run(async () => {
        const result = await deleteActivityProfile({
          apiClient: api,
          confirm: message => window.confirm(message),
        });
        if (result.cancelled) return {reload: false};
        setState(result.nextState);
        return {reload: true};
      }),
    [run],
  );

  return {state, busy, load: () => run(load), signIn, signOut, deleteProfile};
}
