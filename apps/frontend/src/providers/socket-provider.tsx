import { PropsWithChildren, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { io, Socket } from 'socket.io-client';

import { useAuthStore } from '../stores/auth-store';

interface SocketContextValue {
  socket: Socket | null;
  connected: boolean;
}

const SocketContext = createContext<SocketContextValue>({ socket: null, connected: false });

export const SocketProvider = ({ children }: PropsWithChildren) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const status = useAuthStore((state) => state.status);
  const token = useAuthStore((state) => state.token);

  useEffect(() => {
    if (status !== 'authenticated' || !token) {
      setSocket(null);
      setConnected(false);
      return;
    }

    const instance = io('/ws', {
      transports: ['websocket'],
      autoConnect: true,
      auth: { token },
    });

    instance.on('connect', () => {
      setConnected(true);
    });
    instance.on('disconnect', () => {
      setConnected(false);
    });
    instance.on('connect_error', (error) => {
      console.error('Socket connection error', error);
      setConnected(false);
    });

    setSocket(instance);

    return () => {
      instance.off('connect');
      instance.off('disconnect');
      instance.off('connect_error');
      instance.disconnect();
      setSocket(null);
      setConnected(false);
    };
  }, [status, token]);

  const value = useMemo<SocketContextValue>(
    () => ({
      socket,
      connected,
    }),
    [socket, connected],
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
};

export const useSocket = () => useContext(SocketContext).socket;
export const useSocketConnected = () => useContext(SocketContext).connected;
