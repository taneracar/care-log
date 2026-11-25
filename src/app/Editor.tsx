import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { FieldName, Fields } from '../core/ops';
import type { RecordView } from '../core/record';
import type { SyncEngine } from '../sync/engine';
import { DIAPER, FIELD_LABEL, clockTime, showValue, title } from './format';
import { useTheme } from './theme';
import { Button } from './ui';

/**
 * Every control saves at once, there is no draft to lose. Only the note waits for blur, so
 * typing a sentence is one op and not forty.
 */
export function Editor({ entry, engine, onClose }: { entry: RecordView; engine: SyncEngine; onClose: () => void }) {
  const t = useTheme();
  const f = entry.fields;
  const [note, setNote] = useState<string | null>(null);
  const save = (patch: Fields) => engine.update(entry.id, patch);
  const saveNote = () => {
    if (note !== null && note !== (f.note ?? '')) save({ note });
    setNote(null);
  };
  const close = () => {
    saveNote();
    onClose();
  };

  return (
    <ScrollView style={s.fill} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <View style={s.head}>
        <Text role="heading" style={[s.h2, { color: t.text }]}>{title(entry)}</Text>
        <Button label="Done" onPress={close} />
      </View>
      <Text style={{ color: t.muted }}>
        {clockTime(f.at!)} · logged by {f.by ?? 'Unknown'}
      </Text>

      {entry.conflicts.map((c) => (
        <View key={c.field} style={[s.notice, { backgroundColor: t.warnBg }]}>
          <Text role="alert" style={{ color: t.warnText }}>
            {FIELD_LABEL[c.field]} was changed on two phones. Which is right?
          </Text>
          <View style={s.wrap}>
            {c.options.map((o) => {
              const label = `${showValue(c.field, o.value)} (${o.device === engine.device ? 'this phone' : 'other phone'})`;
              return (
                <Button
                  key={o.stamp}
                  label={label}
                  // Starts with the visible text, so "tap 90 ml" works in Voice Control.
                  a11yLabel={`${label}, use this one`}
                  onPress={() => engine.resolve(entry.id, c.field, o.value as Fields[FieldName])}
                />
              );
            })}
          </View>
        </View>
      ))}
      {entry.deleteConflict && (
        <View style={[s.notice, { backgroundColor: t.warnBg }]}>
          <Text role="alert" style={{ color: t.warnText }}>
            This was deleted on one phone while it was being edited on another, so it was kept.
          </Text>
          <Button label="Keep it" disabled={entry.conflicts.length > 0} onPress={() => engine.keep(entry.id)} />
        </View>
      )}

      {f.type === 'feed' && (
        <View style={s.wrap}>
          <Button
            label="−10"
            a11yLabel="10 millilitres less"
            disabled={(f.amountMl ?? 0) < 10}
            onPress={() => save({ amountMl: (f.amountMl ?? 0) - 10 })}
          />
          <Text aria-live="polite" style={[s.amount, { color: t.text }]}>{f.amountMl ?? 0} ml</Text>
          <Button
            label="+10"
            a11yLabel="10 millilitres more"
            disabled={(f.amountMl ?? 0) > 490}
            onPress={() => save({ amountMl: (f.amountMl ?? 0) + 10 })}
          />
        </View>
      )}
      {f.type === 'diaper' && (
        <View style={s.wrap}>
          {(Object.keys(DIAPER) as (keyof typeof DIAPER)[]).map((d) => (
            <Button key={d} label={DIAPER[d]} selected={f.diaper === d} onPress={() => save({ diaper: d })} />
          ))}
        </View>
      )}
      {f.type === 'sleep' && f.endAt == null && (
        <Button label="Awake now" onPress={() => save({ endAt: engine.now() })} />
      )}

      <Text style={[s.label, { color: t.text }]}>Note</Text>
      <TextInput
        aria-label="Note"
        value={note ?? f.note ?? ''}
        onChangeText={setNote}
        onBlur={saveNote}
        maxLength={500}
        multiline
        style={[s.input, { color: t.text, borderColor: t.line, backgroundColor: t.card }]}
      />
      <Button
        danger
        label="Delete entry"
        onPress={() => {
          engine.remove(entry.id);
          onClose();
        }}
      />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 16, gap: 14 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  h2: { fontSize: 24, fontWeight: '700', flexShrink: 1 },
  notice: { padding: 12, borderRadius: 12, gap: 10 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  amount: { fontSize: 22, fontWeight: '600', minWidth: 90, textAlign: 'center' },
  label: { fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 12, padding: 12, minHeight: 72, fontSize: 16, textAlignVertical: 'top' },
});
