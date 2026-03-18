import React from 'react';
import { Security as SecurityIcon, VerifiedUser, PrivacyTip, ReportProblem, Gavel } from '@mui/icons-material';

export default function Security() {
  return (
    <div className="glassmorphism fade-in p-8 rounded-3xl" style={{ border: "1px solid rgba(255,165,0,0.2)" }}>
      <div className="flex justify-between items-center mb-8">
        <h2 className="text-2xl font-bold flex items-center gap-3">
          <SecurityIcon style={{ color: "#ffa500" }} /> Protocol Security & Audits
        </h2>
        <div className="flex gap-4">
          <div className="bg-emerald-500/10 border border-emerald-500/30 px-4 py-2 rounded-xl text-emerald-400 text-sm font-bold flex items-center gap-2">
            <VerifiedUser fontSize="small" /> System Secure
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 mb-6">
        <div className="bg-slate-900/40 p-6 rounded-2xl border border-slate-700/50 flex flex-col items-center justify-center text-center">
           <Gavel className="text-[#ffa500] mb-3" style={{ fontSize: "3rem" }} />
           <h3 className="font-bold text-xl mb-1">Multi-Signature Requirement</h3>
           <p className="text-slate-400 text-sm mb-4">All core protocol upgrades and treasury movements require a 4-of-7 multisig approval.</p>
           <button className="bg-slate-800 text-white border border-slate-600 py-2 px-6 rounded-xl text-sm font-bold hover:bg-slate-700">View Signers (Squads)</button>
        </div>

        <div className="bg-slate-900/40 p-6 rounded-2xl border border-slate-700/50 flex flex-col items-center justify-center text-center">
           <PrivacyTip className="text-[#ffa500] mb-3" style={{ fontSize: "3rem" }} />
           <h3 className="font-bold text-xl mb-1">Smart Contract Audits</h3>
           <p className="text-slate-400 text-sm mb-4">The PocketChange Arbitrage Engine and Vaults have been rigorously audited.</p>
           <button className="bg-[#ffa500] text-black py-2 px-6 rounded-xl text-sm font-bold hover:bg-[#e69500]">Download Latest Report</button>
        </div>
      </div>

      <div className="bg-red-500/5 border border-red-500/30 p-6 rounded-2xl mt-4 relative overflow-hidden">
         <div className="absolute top-0 left-0 w-1 h-full bg-red-500"></div>
         <div className="flex justify-between items-center">
            <div>
              <h3 className="text-red-400 font-bold text-lg flex items-center gap-2 mb-1">
                <ReportProblem /> Emergency Global Pause (Circuit Breaker)
              </h3>
              <p className="text-slate-400 text-sm">
                In the event of a catastrophic MEV or DEX vulnerability, the DAO multi-sig can activate the Circuit Breaker to instantly halt all arbitrage executions and vault withdrawals to protect funds.
              </p>
            </div>
            <button className="ml-8 bg-red-500 hover:bg-red-600 text-white font-bold py-3 px-8 rounded-xl ring-4 ring-red-500/20 transition-colors whitespace-nowrap">
              Simulate Pause
            </button>
         </div>
      </div>
    </div>
  );
}
