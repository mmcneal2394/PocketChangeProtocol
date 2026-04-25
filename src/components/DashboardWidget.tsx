'use client';

import { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Badge,
} from '@/components/ui';
import { Activity, Cpu, TrendingUp } from 'lucide-react';

interface Config {
  MIN_SPREAD_PCT: number;
  MIN_LIQUIDITY_USD: number;
  MAX_SLIPPAGE_BPS: number;
  PRIORITY_FEE_MICROLAMPORTS: number;
  TRADE_COOLDOWN_MS: number;
  BUY_AMOUNT_USDC: number;
  BUY_AMOUNT_SOL: number;
}

interface TuningEvent {
  channel: 'CONFIG_UPDATE';
  data: Partial<Config>;
  timestamp: number;
}

interface Heartbeat {
  channel: 'HEARTBEAT';
  data: { agent: string; status: string; lastMintMs?: number; walletsTracked?: number };
}

export default function DashboardWidget() {
  const [config, setConfig] = useState<Config | null>(null);
  const [tuningLog, setTuningLog] = useState<TuningEvent[]>([]);
  const [heartbeats, setHeartbeats] = useState<Record<string, Heartbeat['data']>>({});

  useEffect(() => {
    const wsHost = process.env.NEXT_PUBLIC_WS_BRIDGE?.trim();
    if (!wsHost) return;

    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const connect = () => {
      socket = new WebSocket(wsHost);

      socket.onopen = () => console.log('Dashboard WS connected:', wsHost);
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.channel === 'CONFIG_UPDATE') {
            setConfig((prev) => ({ ...prev, ...msg.data } as Config));
            setTuningLog((prev) => [{ ...msg, timestamp: Date.now() }, ...prev].slice(0, 50));
          } else if (msg.channel === 'HEARTBEAT') {
            setHeartbeats((prev) => ({ ...prev, [msg.data.agent]: msg.data }));
          }
        } catch {}
      };
      socket.onclose = () => {
        if (!closed) {
          retryTimer = setTimeout(connect, 3000);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 p-4">
      {/* Live Config Card */}
      <Card className="col-span-1 border-white/10 bg-black backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-white/90">
            <Cpu className="h-5 w-5 text-indigo-400" />
            Active Swarm Configuration
          </CardTitle>
        </CardHeader>
        <CardContent>
          {config ? (
            <div className="space-y-2">
              {Object.entries(config).map(([key, value]) => (
                <div key={key} className="flex justify-between text-sm">
                  <span className="font-mono text-white/60">{key}</span>
                  <span className="font-bold text-white shadow-sm">{String(value)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-white/40">
              {process.env.NEXT_PUBLIC_WS_BRIDGE ? 'Waiting for remote config sync...' : 'Remote event bridge not configured.'}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Agent Heartbeats */}
      <Card className="border-white/10 bg-black backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-white/90">
            <Activity className="h-5 w-5 text-emerald-400" />
            Hive Agent Cluster Pulse
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {Object.entries(heartbeats).map(([name, data]) => (
              <div key={name} className="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center border-b border-white/5 pb-2">
                <span className="font-mono text-white/80">{name}</span>
                <div className="flex items-center gap-2 mt-1 sm:mt-0">
                    <Badge variant={data.status === 'alive' ? 'default' : 'destructive'} 
                           className={data.status === 'alive' ? 'bg-emerald-500/20 text-emerald-300' : ''}>
                      {data.status.toUpperCase()}
                    </Badge>
                    {data.lastMintMs && (
                      <span className="text-xs text-white/40 font-mono">
                        {new Date(data.lastMintMs).toLocaleTimeString()}
                      </span>
                    )}
                </div>
              </div>
            ))}
            {Object.keys(heartbeats).length === 0 && (
                <p className="text-white/40">Awaiting agent connections...</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Tuning Decision Log */}
      <Card className="col-span-1 lg:col-span-2 border-white/10 bg-black backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-white/90">
            <TrendingUp className="h-5 w-5 text-amber-400" />
            AI Hive Mind – Autonomous Drift Triggers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-white/5">
                <TableHead className="text-white/50">Execution Time</TableHead>
                <TableHead className="text-white/50">Modulated Field</TableHead>
                <TableHead className="text-white/50">Drift Vector</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tuningLog.flatMap((event) =>
                Object.entries(event.data).map(([param, value]) => (
                  <TableRow key={`${event.timestamp}-${param}`} className="border-white/5 hover:bg-white/5">
                    <TableCell className="text-white/80 font-mono">{new Date(event.timestamp).toLocaleTimeString()}</TableCell>
                    <TableCell className="font-mono text-amber-200/90">{param}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="border-white/20 text-white shadow-md bg-white/5">{String(value)}</Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
              {tuningLog.length === 0 && (
                <TableRow className="border-none hover:bg-transparent">
                  <TableCell colSpan={3} className="text-center text-white/30 h-24">
                    Monitoring parameter drift... (Engine Nominal)
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
