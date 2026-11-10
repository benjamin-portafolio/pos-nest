import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Optional } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ServerStateService } from '../recovery/server-state.service';
interface EventsAvailablePayload {
  latestServerSequence: number;
  eventTypes: string[];
  sourceDeviceId: string;
}
@WebSocketGateway({ cors: { origin: '*', credentials: true } })
export class EventsGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;
  constructor(@Optional() private readonly state?: ServerStateService) {}
  async handleConnection(client: Socket) {
    try {
      if (!this.state) throw new Error('Identity guard unavailable');
      const a = client.handshake.auth;
      await this.state.business(
        {
          protocol: a.protocol,
          server: a.server_instance_id,
          generation: a.generation_id,
          token: a.token,
          device: a.device_id,
        },
        async (s, b) => {
          client.data.binding = {
            protocol: a.protocol,
            server: a.server_instance_id,
            generation: a.generation_id,
            token: a.token,
            device: a.device_id,
          };
          await client.join('generation:' + s.generation_id);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const expiresAt = new Date(b.expires_at).getTime();
          const checkExpiry = () => {
            const remaining = expiresAt - Date.now();
            if (remaining <= 0) {
              client.disconnect(true);
              return;
            }
            // Node clamps longer delays to 1ms. Re-arm within its signed
            // 32-bit bound so a thirty-day binding remains connected.
            timer = setTimeout(checkExpiry, Math.min(remaining, 2147483647));
            timer.unref();
          };
          client.once('disconnect', () => {
            if (timer) clearTimeout(timer);
          });
          checkExpiry();
        },
      );
    } catch {
      client.disconnect(true);
    }
  }
  // The former generic message/broadcast channel is deliberately removed.
  async notifyEventsAvailable(payload: EventsAvailablePayload): Promise<void> {
    if (!this.state || !this.server) return;
    for (const client of this.server.sockets.sockets.values()) {
      try {
        await this.state.business(client.data.binding ?? {}, async () => {
          client.emit('sync:events_available', {
            latest_server_sequence: payload.latestServerSequence,
            event_types: payload.eventTypes,
            source_device_id: payload.sourceDeviceId,
          });
        });
      } catch {
        client.disconnect(true);
      }
    }
  }
}
