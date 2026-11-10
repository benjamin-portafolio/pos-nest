import { EventsGateway } from './events.gateway';
describe('binding expiration on WebSocket', () => {
  afterEach(() => jest.useRealTimers());
  test('thirty-day binding re-arms timers without overflowing or disconnecting early', async () => {
    jest.useFakeTimers();
    const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const client = {
      handshake: { auth: { protocol: '2' } },
      data: {},
      join: jest.fn(),
      disconnect: jest.fn(),
      once: jest.fn(),
    };
    const state = {
      business: async (_: any, fn: any) =>
        fn(
          { generation_id: 'generation' },
          { expires_at: new Date(expires).toISOString() },
        ),
    };
    await new EventsGateway(state as any).handleConnection(client as any);
    expect(client.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2147483647);
    expect(client.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(expires - Date.now() - 1);
    expect(client.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });
});
