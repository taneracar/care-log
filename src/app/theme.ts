import { useColorScheme } from 'react-native';

const light = {
  bg: '#f6f4ef', card: '#ffffff', text: '#1d1b16', muted: '#645f55', line: '#dcd7cb',
  accent: '#1f5f5b', onAccent: '#ffffff', warnBg: '#fdf0d3', warnText: '#6b4700', danger: '#a3261c',
};
const dark: typeof light = {
  bg: '#14171a', card: '#1e2327', text: '#eef1f2', muted: '#a7b0b5', line: '#363d43',
  accent: '#7fd1c7', onAccent: '#0c2422', warnBg: '#3d2f10', warnText: '#f5d48c', danger: '#ff9c91',
};
export type Theme = typeof light;
export const useTheme = (): Theme => (useColorScheme() === 'dark' ? dark : light);
