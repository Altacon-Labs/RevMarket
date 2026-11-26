import {useCallback, useEffect, useRef, useState} from 'react';
import {api} from './backend.mjs';

export function useVerifiedActivity({address} = {}) {
  const [state, setState] = useState({
    status: 'loading',
    items: [],
    nextCursor: null,
    pageInfo: {hasMore: false, limit: 25},
    freshness: null,
    verificationSource: null,
    error: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const activeAddress = useRef(address);
  activeAddress.current = address;

  const fetchVerified = useCallback(async (cursor = null, append = false) => {
    if (!address) {
      setState({
        status: 'idle',
        items: [],
        nextCursor: null,
        pageInfo: {hasMore: false, limit: 25},
        freshness: null,
        verificationSource: null,
        error: null,
      });
      return;
    }

    if (!append) {
      setState(s => ({...s, status: 'loading', error: null}));
    } else {
      setLoadingMore(true);
    }

    const currentWallet = activeAddress.current;

    try {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      const query = params.toString();
      const res = await api(`/activity/verified${query ? `?${query}` : ''}`);

      if (activeAddress.current !== currentWallet) return;

      setState(s => ({
        status: 'ready',
        items: append ? [...s.items, ...(res.items || [])] : (res.items || []),
        nextCursor: res.nextCursor || null,
        pageInfo: res.pageInfo || {hasMore: false, limit: 25},
        freshness: res.freshness || null,
        verificationSource: res.verificationSource || null,
        error: null,
      }));
    } catch (err) {
      if (activeAddress.current !== currentWallet) return;
      setState(s => ({
        ...s,
        status: append ? s.status : 'error',
        error: err?.message || 'Failed to load verified activity',
      }));
    } finally {
      if (activeAddress.current === currentWallet) {
        setLoadingMore(false);
      }
    }
  }, [address]);

  useEffect(() => {
    fetchVerified(null, false);
  }, [address, fetchVerified]);

  const loadMore = useCallback(() => {
    if (state.nextCursor && !loadingMore) {
      fetchVerified(state.nextCursor, true);
    }
  }, [state.nextCursor, loadingMore, fetchVerified]);

  const refresh = useCallback(() => {
    fetchVerified(null, false);
  }, [fetchVerified]);

  return {
    ...state,
    loadingMore,
    loadMore,
    refresh,
  };
}
