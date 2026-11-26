import test from 'node:test';
import assert from 'node:assert/strict';
import {loadActivityProfileState} from '../frontend/src/lib/activity-profile.mjs';

test('frontend activity profile and verified feed state handling', async () => {
  const calls = [];
  const mockApiClient = async (path, options) => {
    calls.push({path, options});
    if (path === '/health') return {status: 'ok'};
    if (path === '/me') return {wallet: 'GBALICE...', role: 'user'};
    if (path === '/activity') return {items: [{action: 'predict', timestamp: Date.now()}]};
    return {};
  };

  const state = await loadActivityProfileState({address: 'GBALICE...', apiClient: mockApiClient});
  assert.equal(state.status, 'online');
  assert.equal(state.profile.wallet, 'GBALICE...');
  assert.equal(state.items.length, 1);
  assert.equal(calls.some(c => c.path === '/activity/verified'), false);
});
