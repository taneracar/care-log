import { useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { CareLog } from './src/app/CareLog';
import { createDemo, type DemoPhone } from './src/app/demo';
import { useTheme } from './src/app/theme';
import { Button } from './src/app/ui';

/** Web build: two phones on one page, sharing an in-memory server. Nothing leaves the tab. */
export default function App() {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const [phones] = useState(createDemo);
  return (
    <SafeAreaProvider>
      <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={s.page}>
        <Text role="heading" style={[s.h1, { color: t.text }]}>Care log: two phones, one baby</Text>
        <Text style={[s.intro, { color: t.muted }]}>
          Take a phone offline, change the same feed on both, then reconnect. Everything runs in this tab, with no real server or data.
        </Text>
        <View style={[s.phones, { flexDirection: width < 760 ? 'column' : 'row' }]}>
          {phones.map((p) => (
            <PhoneFrame key={p.owner} phone={p} wide={width >= 760} />
          ))}
        </View>
      </ScrollView>
    </SafeAreaProvider>
  );
}

function PhoneFrame({ phone, wide }: { phone: DemoPhone; wide: boolean }) {
  const t = useTheme();
  const [online, setOnline] = useState(true);
  return (
    <View role="region" aria-label={`${phone.owner}'s phone`} style={[s.column, wide && s.half]}>
      <View style={s.bar}>
        <Text style={[s.owner, { color: t.text }]}>{phone.owner}’s phone</Text>
        <Button
          label={online ? 'Go offline' : 'Reconnect'}
          a11yLabel={`${online ? 'Take offline' : 'Reconnect'}: ${phone.owner}`}
          onPress={() => {
            phone.setOnline(!online);
            setOnline(!online);
          }}
        />
      </View>
      <View style={[s.frame, { borderColor: t.line }]}>
        <CareLog engine={phone.engine} me={phone.owner} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, gap: 12, alignItems: 'center', flexGrow: 1 },
  h1: { fontSize: 24, fontWeight: '700', textAlign: 'center' },
  intro: { maxWidth: 620, textAlign: 'center', fontSize: 15, lineHeight: 22 },
  phones: { gap: 24, width: '100%', maxWidth: 860 },
  column: { gap: 8, minWidth: 0 },
  half: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  owner: { fontSize: 17, fontWeight: '600' },
  frame: { height: 620, borderWidth: 1, borderRadius: 24, overflow: 'hidden' },
});
