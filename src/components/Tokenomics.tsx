"use client";

import React, { useState, useEffect } from 'react';
import { AccountBalance, HowToVote, Functions, PieChart, LocalFireDepartment, Savings } from '@mui/icons-material';

export default function Tokenomics() {
  const [data, setData] = useState<any>(null);

  const fetchTokenomics = async () => {
    try {
      const res = await fetch('/api/tokenomics');
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchTokenomics();
    const interval = setInterval(fetchTokenomics, 3000); // Fast 3s poll for demo feel
    return () => clearInterval(interval);
  }, []);
  return (
    <div className="glassmorphism fade-in p-8 rounded-3xl" style={{ border: "1px solid rgba(255,0,128,0.2)" }}>
      <div className="flex justify-between items-center mb-8">
        <h2 className="text-2xl font-bold flex items-center gap-3">
          <AccountBalance style={{ color: "#ff0080" }} /> $PCP Tokenomics & Governance
        </h2>
        <div className="bg-slate-800/80 px-4 py-2 rounded-xl text-sm border border-slate-600 font-medium">
          Total Supply: <span className="font-bold text-slate-400 mr-2">1,000,000,000 $PCP</span> 
          Circulating: <span className="font-bold text-[#ff0080]" style={{ animation: "pulse 2s infinite" }}>
              {data ? data.circulatingSupply.toLocaleString() : "..."} $PCP
          </span>
        </div>
      </div>

      <div className="mb-8">
          <p className="text-sm font-mono text-slate-400 bg-slate-900/50 p-3 rounded-lg border border-slate-700 inline-block w-full text-center">
            <strong>Official Contract:</strong> <span className="text-[#00FFaa]">4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS</span>
          </p>
      </div>

      {data && data.allocations && (
          <div className="bg-slate-900/40 p-6 rounded-2xl border border-slate-700/50 mb-8">
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2"><PieChart style={{color: "#00ccff"}} /> Token Allocation</h3>
              
              <div className="w-full h-8 rounded-full overflow-hidden flex mb-6 shadow-inner relative">
                  {data.allocations.map((alloc: any) => (
                      <div 
                        key={alloc.label}
                        title={`${alloc.label} - ${alloc.percentage}%`}
                        style={{ 
                            width: `${alloc.percentage}%`, 
                            backgroundColor: alloc.color,
                            opacity: 0.9,
                            borderRight: "1px solid rgba(0,0,0,0.2)"
                        }} 
                        className="h-full hover:opacity-100 transition-opacity cursor-pointer"
                      />
                  ))}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-y-4 gap-x-2">
                  {data.allocations.map((alloc: any) => (
                      <div key={alloc.label} className="flex items-center gap-2">
                          <span className="w-3 h-3 rounded-full shadow-sm" style={{ backgroundColor: alloc.color }}></span>
                          <span className="text-sm font-medium text-slate-300">{alloc.percentage}% {alloc.label}</span>
                      </div>
                  ))}
              </div>
          </div>
      )}

      <div className="grid grid-cols-2 gap-8">
        <div className="space-y-6">
          <div className="bg-slate-900/40 p-6 rounded-2xl border border-slate-700/50 relative overflow-hidden">
             <h3 className="text-lg font-bold mb-6 flex items-center gap-2 relative z-10"><LocalFireDepartment style={{color: "#ff8c00"}} /> Live Protocol Events</h3>
             
             <div className="space-y-3 relative z-10 h-[210px] overflow-hidden flex flex-col justify-center">
                {!data ? (
                     <p className="text-slate-400 text-sm text-center italic">Scanning blockchain...</p>
                ) : data.recentActions.map((action: any) => (
                    <div key={action.id} className="flex justify-between items-center bg-slate-800/40 p-3 rounded-lg border border-slate-700/50 hover:bg-slate-800 transition-colors">
                        <div className="flex items-center gap-3">
                            {action.type === 'burn' ? 
                                <span className="bg-orange-500/20 text-orange-400 p-2 rounded-lg flex items-center justify-center"><LocalFireDepartment fontSize="small"/></span> : 
                                <span className="bg-emerald-500/20 text-emerald-400 p-2 rounded-lg flex items-center justify-center"><Savings fontSize="small"/></span>
                            }
                            <div>
                                <p className="text-sm font-bold text-slate-200">{action.title}</p>
                                <p className="text-xs text-slate-400 font-mono tracking-tighter">{action.hash}</p>
                            </div>
                        </div>
                        <div className="text-right">
                           <p className={`text-sm font-bold ${action.type === 'burn' ? 'text-orange-400' : 'text-emerald-400'}`}>{action.amount}</p>
                           <p className="text-xs text-slate-500">{action.time}</p>
                        </div>
                    </div>
                ))}
            </div>

            <div className="mt-4 pt-4 border-t border-slate-800/50 flex justify-between items-center px-2">
                <div>
                   <p className="text-xs text-slate-400 uppercase tracking-wider font-bold mb-1">Total Erased Supply</p>
                   <p className="text-xl font-black text-orange-500">{data ? data.totalBurned.toLocaleString() : "0"} PCP</p>
                </div>
                <div className="text-right">
                   <p className="text-xs text-slate-400 uppercase tracking-wider font-bold mb-1">Fees Claimed (24h)</p>
                   <p className="text-xl font-black text-emerald-500">${data ? data.totalFeesClaimed.toLocaleString() : "0"}</p>
                </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-slate-900/40 p-6 rounded-2xl border border-slate-700/50">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2"><HowToVote fontSize="small"/> Active Governance Proposals</h3>
            
            <div className="space-y-4">
              <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-600 hover:border-[#ff0080] transition-colors cursor-pointer">
                <div className="flex justify-between items-start mb-2">
                  <h4 className="font-bold text-sm">PCP-04: Integrate Jupiter v6 API Route</h4>
                  <span className="bg-emerald-500/20 text-emerald-400 px-2 py-1 rounded text-xs font-bold">Active</span>
                </div>
                <div className="w-full bg-slate-900 h-1.5 rounded-full mt-3 overflow-hidden flex">
                  <div className="bg-emerald-500 w-[82%] h-full"></div>
                  <div className="bg-red-500 w-[18%] h-full"></div>
                </div>
                <div className="flex justify-between text-xs mt-1 text-slate-400 font-medium">
                  <span>82% For</span>
                  <span>Ends in 12h</span>
                </div>
              </div>

              <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-600 hover:border-[#ff0080] transition-colors cursor-pointer">
                <div className="flex justify-between items-start mb-2">
                  <h4 className="font-bold text-sm">PCP-05: Adjust Slippage Tolerance to 0.8%</h4>
                  <span className="bg-blue-500/20 text-blue-400 px-2 py-1 rounded text-xs font-bold">Passed</span>
                </div>
                <div className="w-full bg-slate-900 h-1.5 rounded-full mt-3 overflow-hidden flex">
                  <div className="bg-emerald-500 w-[95%] h-full"></div>
                  <div className="bg-red-500 w-[5%] h-full"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
