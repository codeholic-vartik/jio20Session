import { AuthenticatedUser } from '../jwt-auth.service';
import { Socket } from 'socket.io';

/**
 * Extended Socket interface with authenticated user information
 */
export interface AuthenticatedSocket extends Socket {
  user?: AuthenticatedUser;
}

/**
 * Type guard to check if socket is authenticated
 */
export function isAuthenticatedSocket(
  socket: Socket,
): socket is AuthenticatedSocket {
  return (socket as AuthenticatedSocket).user !== undefined;
}
