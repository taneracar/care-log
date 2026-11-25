import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { possibleDuplicates, summarize } from '../core/entries';
import type { RecordView } from '../core/record';
import type { Snapshot, SyncEngine } from '../sync/engine';
import { Editor } from './Editor';
import { clockTime, duration, title } from './format';
import { useTheme, type Theme } from './theme';
import { Button } from './ui';

const LAST_AMOUNT = 120;

export function CareLog({ engine, me }: { engine: SyncEngine; me: string }) {
  const t = useTheme();
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  const now = useNow(engine);
  const [openId, setOpenId] = useState<string | null>(null);

  const duplicates = useMemo(() => possibleDuplicates(snap.entries), [snap.entries]);
  const day = summarize(snap.entries, now);
  const napping = snap.entries.find((e) => e.fields.type === 'sleep' && e.fields.endAt == null);
  const open = snap.entries.find((e) => e.id === openId);
  const lastFeed = snap.entries.find((e) => e.fields.type === 'feed')?.fields.amountMl ?? LAST_AMOUNT;

  return (
    <View style={[s.screen, { backgroundColor: t.bg }]}>
      {/* Hidden, not unmounted, behind the editor: the scroll position survives. */}
      <View style={[s.screen, open && { display: 'none' }]}>
        <View style={s.head}>
          <Text role="heading" style={[s.h1, { color: t.text }]}>Today</Text>
          <SyncBadge snap={snap} t={t} onPress={() => void engine.sync()} />
        </View>
        <Text style={[s.summary, { color: t.muted }]}>
          {day.feeds} {day.feeds === 1 ? 'feed' : 'feeds'} ({day.feedMl} ml) · {day.diapers}{' '}
          {day.diapers === 1 ? 'diaper' : 'diapers'} · {duration(day.sleepMs)} sleep
        </Text>
        {snap.rejected > 0 && (
          <View style={[s.notice, { backgroundColor: t.warnBg }]}>
            <Text role="alert" style={{ color: t.warnText }}>
              {snap.rejected} {snap.rejected === 1 ? 'change was' : 'changes were'} refused by the server and only exist on this phone.
            </Text>
            <Button label="Try again" onPress={() => engine.retryRejected()} />
          </View>
        )}
        <View style={s.actions}>
          <Button
            primary
            label="Feed"
            onPress={() => setOpenId(engine.create({ type: 'feed', at: engine.now(), amountMl: lastFeed, by: me }))}
          />
          <Button
            primary
            label="Diaper"
            onPress={() => setOpenId(engine.create({ type: 'diaper', at: engine.now(), diaper: 'wet', by: me }))}
          />
          {napping ? (
            <Button primary label="Awake" onPress={() => engine.update(napping.id, { endAt: engine.now() })} />
          ) : (
            <Button
              primary
              label="Asleep"
              onPress={() => engine.create({ type: 'sleep', at: engine.now(), endAt: null, by: me })}
            />
          )}
        </View>
        <FlatList
          data={snap.entries}
          keyExtractor={(e) => e.id}
          contentContainerStyle={s.list}
          ListEmptyComponent={<Text style={[s.empty, { color: t.muted }]}>Nothing logged yet.</Text>}
          renderItem={({ item }) => (
            <Row entry={item} t={t} duplicate={duplicates.has(item.id)} onPress={() => setOpenId(item.id)} />
          )}
        />
      </View>
      {open && <Editor key={open.id} entry={open} engine={engine} onClose={() => setOpenId(null)} />}
    </View>
  );
}

function Row({ entry, t, duplicate, onPress }: { entry: RecordView; t: Theme; duplicate: boolean; onPress: () => void }) {
  const flags = [
    entry.conflicts.length > 0 && 'Two versions, pick one',
    entry.deleteConflict && 'Deleted on one phone, edited on another',
    duplicate && 'Logged twice?',
  ].filter((f): f is string => Boolean(f));
  const sub = `${clockTime(entry.fields.at!)} · ${entry.fields.by ?? 'Unknown'}`;
  return (
    <Pressable
      role="button"
      aria-label={[title(entry), sub, entry.fields.note, ...flags].filter(Boolean).join(', ')}
      onPress={onPress}
      style={({ pressed }) => [s.row, { backgroundColor: t.card, borderColor: t.line, opacity: pressed ? 0.7 : 1 }]}
    >
      <Text style={[s.rowTitle, { color: t.text }]}>{title(entry)}</Text>
      <Text style={{ color: t.muted }}>{sub}</Text>
      {entry.fields.note ? <Text style={{ color: t.text }}>{entry.fields.note}</Text> : null}
      {flags.map((f) => (
        <Text key={f} style={[s.flag, { backgroundColor: t.warnBg, color: t.warnText }]}>{f}</Text>
      ))}
    </Pressable>
  );
}

function syncLabel({ status, pending }: Snapshot): string {
  const waiting = pending > 0 ? ` · ${pending} waiting` : '';
  switch (status) {
    case 'syncing': return 'Syncing';
    case 'offline': return `Offline${waiting}`;
    case 'error': return `Sync problem${waiting}`;
    case 'auth': return `Not signed in${waiting}`;
    case 'local': return 'On this phone only';
    case 'idle': return pending > 0 ? `${pending} waiting` : 'Synced';
  }
}

function SyncBadge({ snap, t, onPress }: { snap: Snapshot; t: Theme; onPress: () => void }) {
  const label = syncLabel(snap);
  return (
    <Pressable
      role="button"
      aria-label={`${label}. Sync now`}
      disabled={snap.status === 'local'}
      onPress={onPress}
      hitSlop={8}
      style={[s.badge, { borderColor: t.line, backgroundColor: t.card }]}
    >
      <Text aria-live="polite" style={{ color: t.text }}>{label}</Text>
    </Pressable>
  );
}

function useNow(engine: SyncEngine): number {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return engine.now();
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 16, paddingTop: 12 },
  h1: { fontSize: 30, fontWeight: '700' },
  summary: { paddingHorizontal: 16, paddingTop: 4, fontSize: 15 },
  notice: { margin: 16, marginBottom: 0, padding: 12, borderRadius: 12, gap: 8 },
  actions: { flexDirection: 'row', gap: 8, padding: 16 },
  list: { paddingHorizontal: 16, paddingBottom: 32, gap: 8 },
  empty: { paddingVertical: 24, textAlign: 'center' },
  row: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 4 },
  rowTitle: { fontSize: 17, fontWeight: '600' },
  flag: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden', fontSize: 13 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
});
