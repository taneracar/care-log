import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from './theme';

interface ButtonProps {
  label: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  selected?: boolean;
  disabled?: boolean;
  a11yLabel?: string;
}

export function Button({ label, onPress, primary, danger, selected, disabled, a11yLabel }: ButtonProps) {
  const t = useTheme();
  const filled = primary || selected;
  return (
    <Pressable
      role="button"
      aria-label={a11yLabel ?? label}
      aria-selected={selected}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        {
          backgroundColor: filled ? t.accent : t.card,
          borderColor: filled ? t.accent : danger ? t.danger : t.line,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
        primary && s.grow,
      ]}
    >
      <Text style={[s.label, { color: filled ? t.onAccent : danger ? t.danger : t.text }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  button: { minHeight: 48, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  grow: { flexGrow: 1, flexBasis: 0 },
  label: { fontSize: 16, fontWeight: '600' },
});
