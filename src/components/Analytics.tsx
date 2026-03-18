import React from 'react';
import { Analytics as AnalyticsIcon, TrendingUp, ShowChart, CheckCircle, AccessTime, Savings } from '@mui/icons-material';

export default function Analytics() {
  return (
    <div className="glassmorphism fade-in p-8 rounded-3xl" style={{ border: "1px solid rgba(150,100,255,0.2)" }}>
      <div className="flex justify-between items-center mb-8">
        <h2 className="text-2xl font-bold flex items-center gap-3">
          <AnalyticsIcon style={{ color: "#9664ff" }} /> Analytics & Reporting
        </h2>
        <div className="flex gap-4">
          <button className="bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-xl text-sm font-bold border border-slate-600 transition-colors">Export CSV</button>
          <button className="bg-[#9664ff] hover:bg-[#8545ff] px-4 py-2 rounded-xl text-white text-sm font-bold transition-colors">Download PDF Report</button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-6 mb-8">
        <div className="bg-slate-900/40 p-6 rounded-2xl border border-slate-700/50">
           <div className="flex justify-between items-start mb-2">
             <span className="text-slate-400 text-sm font-bold uppercase tracking-wider">Success Rate</span>
             <CheckCircle className="text-emerald-400" fontSize="small" />
           </div>
           <h3 className="text-3xl font-black text-white">95.3%</h3>
           <p className="text-emerald-400 text-xs font-bold mt-2">+1.2% this week</p>
        </div>
        
        <div className="bg-slate-900/40 p-6 rounded-2xl border border-slate-700/50">
           <div className="flex justify-between items-start mb-2">
             <span className="text-slate-400 text-sm font-bold uppercase tracking-wider">Avg Exec Time</span>
             <AccessTime className="text-blue-400" fontSize="small" />
           </div>
           <h3 className="text-3xl font-black text-white">34ms</h3>
           <p className="text-blue-400 text-xs font-bold mt-2">-4ms optimization</p>
        </div>

        <div className="bg-slate-900/40 p-6 rounded-2xl border border-slate-700/50">
           <div className="flex justify-between items-start mb-2">
             <span className="text-slate-400 text-sm font-bold uppercase tracking-wider">Gas Savings</span>
             <Savings className="text-amber-400" fontSize="small" />
           </div>
           <h3 className="text-3xl font-black text-white">$14.2K</h3>
           <p className="text-amber-400 text-xs font-bold mt-2">Jito bundled</p>
        </div>

        <div className="bg-slate-900/40 p-6 rounded-2xl border border-slate-700/50">
           <div className="flex justify-between items-start mb-2">
             <span className="text-slate-400 text-sm font-bold uppercase tracking-wider">Total PnL (30d)</span>
             <TrendingUp className="text-emerald-400" fontSize="small" />
           </div>
           <h3 className="text-3xl font-black text-emerald-400">+$245K</h3>
           <p className="text-emerald-400 text-xs font-bold mt-2">Across 12k trades</p>
        </div>
      </div>

      <div className="bg-slate-900/40 border border-slate-700/50 rounded-2xl p-6 h-64 flex flex-col justify-end relative overflow-hidden">
        <div className="flex justify-between w-full absolute top-6 left-6 pr-12">
           <h4 className="font-bold text-lg flex items-center gap-2"><ShowChart /> Daily Profit/Loss Chart</h4>
           <div className="flex gap-2 text-xs font-bold">
             <span className="bg-[#9664ff]/20 text-[#9664ff] px-3 py-1 rounded-full">Gross Profit</span>
             <span className="bg-slate-800 text-slate-400 px-3 py-1 rounded-full">Gas Fees</span>
           </div>
        </div>
        <div className="w-full flex items-end justify-between px-4 pb-4 h-full pt-16 gap-2">
           {/* Mock Bar Chart */}
           {[40, 60, 45, 80, 50, 90, 100, 75, 45, 65, 85, 110].map((h, i) => (
             <div key={i} className="w-full bg-[#9664ff] rounded-t-md opacity-80 hover:opacity-100 transition-opacity relative group" style={{ height: `${h}%` }}>
               <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-slate-800 text-[#9664ff] text-xs font-bold py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition-opacity shadow-lg border border-[#9664ff]/30 z-10">
                 +${h * 14}
               </div>
             </div>
           ))}
        </div>
      </div>
    </div>
  );
}
