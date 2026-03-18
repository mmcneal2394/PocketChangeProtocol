import React from 'react';
import { Settings, AutoMode, Tune, Save } from '@mui/icons-material';

export default function StrategyBuilder() {
  return (
    <div className="glassmorphism fade-in p-8 rounded-3xl" style={{ border: "1px solid rgba(0,200,255,0.2)" }}>
      <div className="flex justify-between items-center mb-8">
        <h2 className="text-2xl font-bold flex items-center gap-3">
          <AutoMode style={{ color: "#00c8ff" }} /> Auto-Executor & Strategy Builder
        </h2>
        <div className="flex shadow-lg rounded-full bg-slate-800/50 p-1">
          <button className="bg-[#00c8ff] text-black font-bold px-6 py-2 rounded-full">Active</button>
          <button className="text-slate-400 font-bold px-6 py-2 rounded-full hover:text-white">Paused</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-8">
        <div className="space-y-6">
          <div className="bg-slate-900/40 p-6 rounded-2xl border border-slate-700/50">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2"><Tune fontSize="small"/> Execution Parameters</h3>
            
            <div className="space-y-4">
              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm text-slate-400 font-medium">Minimum Profit Threshold (USDC)</label>
                  <span className="font-bold text-emerald-400">$10.00</span>
                </div>
                <input type="range" className="w-full accent-[#00c8ff]" min="1" max="100" defaultValue="10" />
              </div>
              
              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm text-slate-400 font-medium">Maximum Slippage Tolerance</label>
                  <span className="font-bold text-blue-400">0.0% (Disabled)</span>
                </div>
                <input type="range" className="w-full accent-blue-500 opacity-50 cursor-not-allowed" min="0.0" max="5" step="0.1" defaultValue="0.0" disabled />
              </div>

              <div>
                <label className="text-sm text-slate-400 font-medium block mb-2">Gas Priority Fee (Jito Tip)</label>
                <div className="grid grid-cols-3 gap-4">
                  <button className="bg-[#00c8ff]/20 text-[#00c8ff] border border-[#00c8ff]/50 py-3 rounded-xl font-bold">0 SOL</button>
                  <button className="bg-slate-800 border border-slate-600 py-3 rounded-xl opacity-50 cursor-not-allowed" disabled>Low</button>
                  <button className="bg-slate-800 border border-slate-600 py-3 rounded-xl opacity-50 cursor-not-allowed" disabled>High</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-slate-900/40 p-6 rounded-2xl border border-slate-700/50">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2"><Settings fontSize="small"/> Risk Management (Circuit Breakers)</h3>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between bg-slate-800/50 p-4 rounded-xl">
                <div>
                  <h4 className="font-bold">Max Drawdown Stop-Loss</h4>
                  <p className="text-xs text-slate-400 mt-1">Halt trading if daily loss exceeds limits</p>
                </div>
                <div className="bg-slate-900 px-4 py-2 rounded-lg border border-slate-700">-5.0%</div>
              </div>
              
              <div className="flex items-center justify-between bg-slate-800/50 p-4 rounded-xl border border-emerald-500/30">
                <div>
                  <h4 className="font-bold text-emerald-400">Smart RPC Routing</h4>
                  <p className="text-xs text-slate-400 mt-1">Automatically failover to lowest-latency RPC</p>
                </div>
                <div className="w-12 h-6 bg-emerald-500 rounded-full relative">
                  <div className="w-4 h-4 bg-white rounded-full absolute right-1 top-1"></div>
                </div>
              </div>
            </div>

            <button className="w-full mt-6 bg-gradient-to-r from-blue-600 to-[#00c8ff] py-4 rounded-xl font-bold text-white flex items-center justify-center gap-2 hover:opacity-90 transition-opacity">
              <Save fontSize="small" /> Save Strategy
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
