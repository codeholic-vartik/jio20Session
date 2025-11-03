import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

const WEBSOCKET_NAMESPACE =
  process.env.WEBSOCKET_NAMESPACE || '/ws/v1/session/';

@WebSocketGateway({
  namespace: WEBSOCKET_NAMESPACE,
  cors: { origin: true, credentials: true },
})
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class SocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(SocketGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket): void {
    client.emit('pong');
  }
}
