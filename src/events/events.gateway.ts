import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

interface EventsAvailablePayload {
  latestServerSequence: number;
  eventTypes: string[];
  sourceDeviceId: string;
}

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    console.log(`✅ Cliente conectado: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`❌ Cliente desconectado: ${client.id}`);
  }

  @SubscribeMessage('messageToServer')
  handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: string,
  ): void {
    console.log(`📨 Mensaje recibido de ${client.id}:`, data);

    // Reenviar a TODOS los clientes
    this.server.emit('messageFromServer', {
      from: client.id,
      data: data,
      timestamp: new Date(),
    });
  }

  notifyEventsAvailable(payload: EventsAvailablePayload): void {
    this.server.emit('sync:events_available', {
      latest_server_sequence: payload.latestServerSequence,
      event_types: payload.eventTypes,
      source_device_id: payload.sourceDeviceId,
    });
  }
}
