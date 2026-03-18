import React from 'react';
import { Search, FlashOn, Timeline, WarningAmber, LocalGasStation } from '@mui/icons-material';

export default function Scanner() {
  const opps = [
    { pair: "SOL/USDC", dexA: "Raydium", dexB: "Orca", spread: "1.24%", profit: "+$145.20", confidence: "98%", status: "EXECUTING..." },
    { pair: "JUP/SOL", dexA: "Meteora", dexB: "Jupiter", spread: "0.85%", profit: "+$42.10", confidence: "92%", status: "DETECTED" },
    { pair: "WIF/USDC", dexA: "Raydium", dexB: "Meteora", spread: "2.10%", profit: "+$310.50", confidence: "74%", status: "HIGH RISK" },
  ];

  return (
    <div className="glassmorphism fade-in p-8 rounded-3xl" style={{ border: "1px solid rgba(0,255,170,0.2)" }}>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold flex items-center gap-3">
          <Search style={{ color: "var(--primary)" }} /> Real-Time Arbitrage Scanner
        </h2>
        <div className="flex gap-4">
          <div className="bg-slate-800/50 px-4 py-2 rounded-xl flex items-center gap-2">
            <LocalGasStation fontSize="small" className="text-slate-400" /> <span className="text-emerald-400 font-bold">14 Gwei</span>
          </div>
          <button className="bg-gradient-to-r from-blue-600 to-emerald-500 px-6 py-2 rounded-xl font-bold text-white hover:scale-105 transition-transform flex items-center gap-2">
            <FlashOn fontSize="small" /> Force Scan
          </button>
        </div>
      </div>

      <div className="grid gap-4">
        {opps.map((opp, i) => (
          <div key={i} className="bg-slate-900/40 border border-slate-700/50 rounded-2xl p-6 flex justify-between items-center hover:border-emerald-500/30 transition-colors">
            <div className="flex items-center gap-6">
              <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-slate-700 to-slate-600 shadow-inner flex items-center justify-center font-bold">{opp.pair.split('/')[0]}</div>
              <div>
                <h4 className="text-xl font-bold">{opp.pair}</h4>
                <p className="text-slate-400 text-sm mt-1">{opp.dexA} <span className="text-emerald-400">→</span> {opp.dexB}</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-12 text-center items-center">
              <div>
                <p className="text-slate-400 text-xs uppercase font-bold tracking-wider mb-1">Spread</p>
                <p className="font-bold text-lg">{opp.spread}</p>
              </div>
              <div>
                <p className="text-slate-400 text-xs uppercase font-bold tracking-wider mb-1">Confidence</p>
                <p className="font-bold text-lg text-blue-400">{opp.confidence}</p>
              </div>
              <div>
                <p className="text-slate-400 text-xs uppercase font-bold tracking-wider mb-1">Est. Profit</p>
                <p className="font-bold text-xl text-emerald-400 drop-shadow-[0_0_8px_rgba(0,255,170,0.5)]">{opp.profit}</p>
              </div>
            </div>

            <div>
              <button className={`px-6 py-3 rounded-xl font-bold text-sm tracking-wide ${opp.status.includes('EXECUTING') ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 animate-pulse' : opp.status.includes('RISK') ? 'bg-red-500/10 text-red-400 border border-red-500/30' : 'bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/40'}`}>
                {opp.status}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
