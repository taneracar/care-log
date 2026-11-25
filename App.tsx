import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { CareLog } from './src/app/CareLog';
import { createNativeEngine } from './src/app/nativeEngine';
import { useTheme } from './src/app/theme';
import { useSyncTriggers } from './src/app/useSyncTriggers';

export default function App() {
  const t = useTheme();
  const [engine] = useState(createNativeEngine);
  useSyncTriggers(engine);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
        <StatusBar style="auto" />
        <CareLog engine={engine} me={process.env.EXPO_PUBLIC_CAREGIVER ?? 'Me'} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
