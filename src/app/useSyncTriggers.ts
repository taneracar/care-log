import { addNetworkStateListener } from 'expo-network';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import type { SyncEngine } from '../sync/engine';

const FOREGROUND_POLL_MS = 30_000;

/** Sync on launch, on return to the foreground, when the network returns, and while open. */
export function useSyncTriggers(engine: SyncEngine): void {
  useEffect(() => {
    const go = () => void engine.sync();
    go();
    const app = AppState.addEventListener('change', (state) => state === 'active' && go());
    // Only a hint. "Connected" can still mean a captive portal; the request itself decides.
    const net = addNetworkStateListener((state) => state.isConnected && go());
    const poll = setInterval(() => AppState.currentState === 'active' && go(), FOREGROUND_POLL_MS);
    return () => {
      app.remove();
      net.remove();
      clearInterval(poll);
    };
  }, [engine]);
}
