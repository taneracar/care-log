import { act, fireEvent, render, screen, userEvent } from '@testing-library/react-native';
import { MemoryLog } from '../../server/log';
import { SyncService } from '../../server/service';
import { CareLog } from '../../src/app/CareLog';
import { SyncEngine } from '../../src/sync/engine';
import { TransportError, type Transport } from '../../src/sync/protocol';
import { MemoryOpStore } from '../../src/sync/store';

let ids = 0;
const service = () => new SyncService(new MemoryLog('e'));
const engines: SyncEngine[] = [];

function phone(name: string, server: SyncService | null) {
  const net = { online: true };
  const call = async <T,>(fn: () => T) => {
    if (!net.online) throw new TransportError('network', 'offline');
    return fn();
  };
  const transport: Transport | null = server && {
    push: (ops) => call(() => server.push('h', ops)),
    pull: (after) => call(() => server.pull('h', after)),
  };
  const engine = new SyncEngine({
    store: new MemoryOpStore(), transport, newId: () => `id-${String(++ids).padStart(8, '0')}`,
    newDeviceId: () => name, setTimer: () => 0, clearTimer: () => {},
  });
  engines.push(engine);
  return { engine, net };
}
const settle = (...e: { engine: SyncEngine }[]) =>
  act(async () => {
    for (let i = 0; i < 3; i++) for (const x of e) await x.engine.sync();
  });
afterEach(() => engines.splice(0).forEach((e) => e.stop()));

async function feedOnBoth() {
  const server = service();
  const a = phone('aaaa', server);
  const b = phone('bbbb', server);
  const id = a.engine.create({ type: 'feed', at: Date.now(), amountMl: 100, by: 'Ada' });
  for (let i = 0; i < 3; i++) for (const p of [a, b]) await p.engine.sync();
  const concurrently = async (onA: () => void, onB: () => void) => {
    a.net.online = b.net.online = false;
    onA();
    onB();
    a.net.online = b.net.online = true;
    for (let i = 0; i < 3; i++) for (const p of [a, b]) await p.engine.sync();
  };
  return { a, b, id, concurrently };
}

test('logging a feed offline shows it, and says it is waiting', async () => {
  const p = phone('aaaa', service());
  p.net.online = false;
  const user = userEvent.setup();
  await render(<CareLog engine={p.engine} me="Ada" />);
  await user.press(screen.getByRole('button', { name: 'Feed' }));
  await user.press(screen.getByRole('button', { name: '10 millilitres more' }));
  await user.press(screen.getByRole('button', { name: 'Done' }));
  await settle(p);
  expect(screen.getByText('Feed · 130 ml')).toBeTruthy();
  expect(screen.getByText('1 feed (130 ml) · 0 diapers · 0 min sleep')).toBeTruthy();
  expect(screen.getByText('Offline · 2 waiting')).toBeTruthy();

  p.net.online = true;
  await user.press(screen.getByRole('button', { name: /Sync now/ }));
  await settle(p);
  expect(screen.getByText('Synced')).toBeTruthy();
});

test('a conflict shows both amounts, and choosing one settles it', async () => {
  const { a, b, id, concurrently } = await feedOnBoth();
  await concurrently(() => a.engine.update(id, { amountMl: 120 }), () => b.engine.update(id, { amountMl: 90 }));
  const user = userEvent.setup();
  await render(<CareLog engine={a.engine} me="Ada" />);
  await user.press(screen.getByRole('button', { name: /Two versions, pick one/ }));
  expect(screen.getByRole('alert')).toHaveTextContent('Amount was changed on two phones. Which is right?');
  expect(screen.getByRole('button', { name: '120 ml (this phone), use this one' })).toBeTruthy();
  await user.press(screen.getByRole('button', { name: '90 ml (other phone), use this one' }));
  await settle(a, b);
  expect(screen.queryByText(/two phones/)).toBeNull();
  expect(b.engine.getSnapshot().entries[0]).toMatchObject({ fields: { amountMl: 90 }, conflicts: [] });
});

test('delete against edit asks, and can not be answered before the values are', async () => {
  const { a, b, id, concurrently } = await feedOnBoth();
  await concurrently(
    () => { a.engine.update(id, { amountMl: 1 }); a.engine.remove(id); },
    () => b.engine.update(id, { amountMl: 2 }),
  );
  const user = userEvent.setup();
  await render(<CareLog engine={a.engine} me="Ada" />);
  await user.press(screen.getByRole('button', { name: /Deleted on one phone/ }));
  expect(screen.getByRole('button', { name: 'Keep it' })).toBeDisabled();
  await user.press(screen.getByRole('button', { name: /^2 ml/ }));
  await user.press(screen.getByRole('button', { name: 'Keep it' }));
  await settle(a, b);
  expect(screen.queryByText(/so it was kept/)).toBeNull();
});

test('the note is one op, saved on Done', async () => {
  const p = phone('aaaa', null);
  p.engine.create({ type: 'diaper', diaper: 'wet', at: Date.now(), by: 'Ada' });
  const user = userEvent.setup();
  await render(<CareLog engine={p.engine} me="Ada" />);
  await user.press(screen.getByRole('button', { name: /Diaper · Wet/ }));
  // changeText, not user.type: pressing Done on a phone does not blur the field first.
  await fireEvent.changeText(screen.getByLabelText('Note'), 'rash cream used');
  await user.press(screen.getByRole('button', { name: 'Done' }));
  expect(screen.getByText('rash cream used')).toBeTruthy();
  expect(p.engine.getSnapshot().pending).toBe(2);
});

test('an entry deleted on the other phone closes the editor', async () => {
  const { a, b, id } = await feedOnBoth();
  const user = userEvent.setup();
  await render(<CareLog engine={a.engine} me="Ada" />);
  await user.press(screen.getByRole('button', { name: /Feed · 100 ml/ }));
  b.engine.remove(id);
  await settle(b, a);
  expect(screen.queryByRole('button', { name: 'Delete entry' })).toBeNull();
  expect(screen.getByText('Nothing logged yet.')).toBeTruthy();
});

test('nap: asleep, awake, and the button follows', async () => {
  const p = phone('aaaa', null);
  const user = userEvent.setup();
  await render(<CareLog engine={p.engine} me="Ada" />);
  await user.press(screen.getByRole('button', { name: 'Asleep' }));
  expect(screen.getByText('Sleeping')).toBeTruthy();
  await user.press(screen.getByRole('button', { name: 'Awake' }));
  expect(screen.getByText('Sleep · 0 min')).toBeTruthy();
  expect(screen.getByText('On this phone only')).toBeTruthy();
});

test('changes the server refused are announced and can be retried', async () => {
  const server = service();
  const real = server.push.bind(server);
  server.push = (h, ops) => ({
    ...real(h, []),
    results: ops.map((o) => ({ id: (o as { id: string }).id, status: 'invalid' as const })),
  });
  const p = phone('aaaa', server);
  p.engine.create({ type: 'diaper', diaper: 'wet', at: Date.now(), by: 'Ada' });
  const user = userEvent.setup();
  await render(<CareLog engine={p.engine} me="Ada" />);
  await settle(p);
  expect(screen.getByRole('alert')).toHaveTextContent(/1 change was refused/);
  server.push = real;
  await user.press(screen.getByRole('button', { name: 'Try again' }));
  await settle(p);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('the same feed logged on two phones is pointed out on both rows', async () => {
  const { a, b } = await feedOnBoth();
  b.engine.create({ type: 'feed', at: Date.now(), amountMl: 100, by: 'Ben' });
  await settle(b, a);
  await render(<CareLog engine={a.engine} me="Ada" />);
  expect(screen.getAllByText('Logged twice?')).toHaveLength(2);
});
