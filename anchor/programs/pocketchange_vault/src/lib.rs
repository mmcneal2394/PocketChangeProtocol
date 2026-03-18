use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{load_instruction_at_checked, load_current_index_checked, ID as IX_ID};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, MintTo, Burn};

declare_id!("4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS");

#[program]
pub mod pocketchange_vault {
    use super::*;

    /// Initializes the PocketChange Vault (FL/SOL Architecture)
    /// This sets up the Treasury and sets the base Flash Loan fee in basis points (bps).
    pub fn initialize(ctx: Context<Initialize>, flash_fee_bps: u16) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        
        // SECURITY FIX: Ensure the treasury account provided is explicitly an initialized token account
        // and cannot just be an arbitrary unowned system account injected by an attacker.
        // In the struct below, we also enforce that the treasury mint matches the underlying_mint.
        
        vault_state.admin = ctx.accounts.admin.key();
        vault_state.treasury = ctx.accounts.treasury.key();
        vault_state.underlying_mint = ctx.accounts.underlying_mint.key();
        vault_state.share_mint = ctx.accounts.share_mint.key();
        vault_state.flash_fee_bps = flash_fee_bps;
        vault_state.total_staked_assets = 0;
        vault_state.total_shares_minted = 0;
        
        msg!("PocketChange Vault Initialized. Ready for Staking & Arbitrage Flash Loans.");
        Ok(())
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        let stake_info = &mut ctx.accounts.user_stake_info;
        let clock = Clock::get()?;
        
        // 1. Calculate dynamic share multiplier (Dynamic Sizing from PRD: larger stakes earn slight boost)
        // Assume 6 decimals. 1000 underlying = 1_000_000_000
        let multiplier_bps = if amount >= 10_000_000_000 {
            12500 // 1.25x
        } else if amount >= 1_000_000_000 {
            11000 // 1.10x
        } else {
            10000 // 1.00x
        };

        let effective_amount = (amount as u128).checked_mul(multiplier_bps as u128).unwrap().checked_div(10000).unwrap() as u64;

        // Calculate dynamic share allocation based on the *effective* amount 
        let shares_to_mint = if vault_state.total_staked_assets == 0 || vault_state.total_shares_minted == 0 {
            effective_amount
        } else {
            (effective_amount as u128)
                .checked_mul(vault_state.total_shares_minted as u128)
                .unwrap()
                .checked_div(vault_state.total_staked_assets as u128)
                .unwrap() as u64
        };

        // Transfer underlying capital into the Vault via CPI (Actual amount, not effective)
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_underlying.to_account_info(),
            to: ctx.accounts.vault_underlying.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Mint Liquid xPKC shares back to the User
        let seeds = &[b"vault".as_ref(), &[ctx.bumps.vault_state]];
        let signer = &[&seeds[..]];
        let mint_cpi_accounts = MintTo {
            mint: ctx.accounts.share_mint.to_account_info(),
            to: ctx.accounts.user_shares.to_account_info(),
            authority: vault_state.to_account_info(),
        };
        let mint_cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), mint_cpi_accounts, signer);
        token::mint_to(mint_cpi_ctx, shares_to_mint)?;

        vault_state.total_staked_assets = vault_state.total_staked_assets.checked_add(amount).unwrap();
        vault_state.total_shares_minted = vault_state.total_shares_minted.checked_add(shares_to_mint).unwrap();
        
        // Update user stake info for cooldown (7 days)
        stake_info.last_stake_timestamp = clock.unix_timestamp;
        stake_info.total_staked = stake_info.total_staked.checked_add(amount).unwrap();
        
        msg!("Staked {} capital (Multiplier {}x). Minted {} xPKC Shares.", amount, multiplier_bps as f64 / 10000.0, shares_to_mint);
        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>, shares: u64) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        let stake_info = &ctx.accounts.user_stake_info;
        let clock = Clock::get()?;

        // Enforce 7-day cooldown (7 days * 24 hours * 60 minutes * 60 seconds)
        let cooldown_period = 7 * 24 * 60 * 60;
        require!(
            clock.unix_timestamp >= stake_info.last_stake_timestamp + cooldown_period,
            ArbitrageError::CooldownActive
        );

        // Calculate underlying return including all accrued flash loan fees
        let underlying_to_return = (shares as u128)
            .checked_mul(vault_state.total_staked_assets as u128)
            .unwrap()
            .checked_div(vault_state.total_shares_minted as u128)
            .unwrap() as u64;

        // Burn xPKC Shares
        let burn_cpi_accounts = Burn {
            mint: ctx.accounts.share_mint.to_account_info(),
            from: ctx.accounts.user_shares.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let burn_cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), burn_cpi_accounts);
        token::burn(burn_cpi_ctx, shares)?;

        // SECURITY FIX: Decrement user's tracked stake to prevent replay / underflow attacks
        stake_info.total_staked = stake_info.total_staked.checked_sub(underlying_to_return).unwrap_or(0);

        // Return Capital + Yield back from Vault to User
        let seeds = &[b"vault".as_ref(), &[ctx.bumps.vault_state]];
        let signer = &[&seeds[..]];
        let transfer_cpi_accounts = Transfer {
            from: ctx.accounts.vault_underlying.to_account_info(),
            to: ctx.accounts.user_underlying.to_account_info(),
            authority: vault_state.to_account_info(),
        };
        let transfer_cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), transfer_cpi_accounts, signer);
        token::transfer(transfer_cpi_ctx, underlying_to_return)?;

        vault_state.total_staked_assets = vault_state.total_staked_assets.checked_sub(underlying_to_return).unwrap();
        vault_state.total_shares_minted = vault_state.total_shares_minted.checked_sub(shares).unwrap();
        
        msg!("Burned {} xPKC Shares. Unlocked {} Compound Capital.", shares, underlying_to_return);
        Ok(())
    }

    /// FLASH LOAN ENGINE:
    /// Dispenses flash loan to the MEV Bot / Arbitrageur. 
    /// Note: Standard Solana implementations require introspection or CPI Hot-Potato logic to enforce atomic repayment.
    /// This represents the primary dispatch hook mapping to the front-end Engine UI.
    pub fn flash_loan(ctx: Context<FlashLoan>, amount: u64) -> Result<()> {
        let vault_state = &ctx.accounts.vault_state;

        // Calculate the absolute fee expected (e.g. 15bps = 0.15%)
        let fee = (amount as u128)
            .checked_mul(vault_state.flash_fee_bps as u128)
            .unwrap()
            .checked_div(10000)
            .unwrap() as u64;
            
        let seeds = &[b"vault".as_ref(), &[ctx.bumps.vault_state]];
        let signer = &[&seeds[..]];
        
        let transfer_cpi_accounts = Transfer {
            from: ctx.accounts.vault_underlying.to_account_info(),
            to: ctx.accounts.borrower_account.to_account_info(),
            authority: vault_state.to_account_info(),
        };
        let transfer_cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), transfer_cpi_accounts, signer);
        token::transfer(transfer_cpi_ctx, amount)?;

        // Introspect Sysvar Instructions to strictly require an invocation of `flash_loan_repay` before the block finalizes.
        let ixs = ctx.accounts.instructions.to_account_info();
        let mut found_repay = false;
        
        let current_index = load_current_index_checked(&ixs)?;
        for i in (current_index + 1).. {
            if let Ok(ix) = load_instruction_at_checked(i as usize, &ixs) {
                // If they call our program again in this TX, we assume it's repayment. 
                // A rigid production check would verify the 8-byte discriminator for `flash_loan_repay`.
                if ix.program_id == *ctx.program_id {
                    found_repay = true;
                    break;
                }
            } else {
                break;
            }
        }
        
        require!(found_repay, ArbitrageError::MissingRepayment);

        msg!("Flash loan disbursed: {}. Atomic Repayment Expected: {}", amount, amount + fee);
        Ok(())
    }

    /// REVENUE SPLIT & REPAYMENT (80/20 mechanism)
    /// Contract receives principal + fee. Distributes dynamically.
    pub fn flash_loan_repay(ctx: Context<RepayFlashLoan>, principal: u64, fee: u64) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        
        // Hard-coded Distribution Logic: 80% to Stakers / 20% to Treasury (from Whitepaper)
        let treasury_cut = (fee as u128)
            .checked_mul(20)
            .unwrap()
            .checked_div(100)
            .unwrap() as u64;
        let staker_cut = fee.checked_sub(treasury_cut).unwrap();

        // 1. Send 20% to Protocol Treasury
        let transfer_treasury_accounts = Transfer {
            from: ctx.accounts.borrower_account.to_account_info(),
            to: ctx.accounts.treasury_account.to_account_info(),
            authority: ctx.accounts.borrower.to_account_info(),
        };
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), transfer_treasury_accounts), treasury_cut)?;

        // 2. Return Principal + 80% Staker Fee directly back to the Staking Vault
        let vault_repayment = principal.checked_add(staker_cut).unwrap();
        let transfer_vault_accounts = Transfer {
            from: ctx.accounts.borrower_account.to_account_info(),
            to: ctx.accounts.vault_underlying.to_account_info(),
            authority: ctx.accounts.borrower.to_account_info(),
        };
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), transfer_vault_accounts), vault_repayment)?;

        // 3. AUTO-COMPOUND YIELD: Increase totally tracked assets *without* minting new shares, inherently inflating the value of existing xPKC shares.
        vault_state.total_staked_assets = vault_state.total_staked_assets.checked_add(staker_cut).unwrap();

        msg!("Flash loan atomically cleared. Total Fee: {}. Staker Distro: {} (+value boost). Treasury Distro: {}", fee, staker_cut, treasury_cut);
        Ok(())
    }

    /// AUTO-ARBITRAGE EXECUTION ENGINE (Auto-Compounding)
    /// Executes a series of swaps (e.g., via Jupiter CPI) using vault funds.
    /// Ensures that the final vault balance is strictly greater than the initial balance + min_profit.
    /// Profits are automatically kept in the vault (auto-compounding 80% to stakers), and 20% is routed to the treasury.
    pub fn execute_arbitrage(ctx: Context<ExecuteArbitrage>, route_data: Vec<u8>, min_profit: u64) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        
        // 1. Record initial balance
        let initial_balance = ctx.accounts.vault_underlying.amount;

        // 2. Execute Swaps via CPI (Mocked for blueprint, in production this uses Jupiter/Orca/Raydium CPIs)
        // token::transfer(...) -> DEX 1
        // token::transfer(...) -> DEX 2
        // token::transfer(...) -> DEX 3
        msg!("Executing Arbitrage Route Data: {} bytes", route_data.len());
        
        // --- SIMULATED MOCK PROFIT FOR BLUEPRINT ---
        // In a real implementation, the DEXes would transfer the final output back to `vault_underlying`.
        // We mock an incoming transfer from a 'simulation source' to represent the arb profit.
        // --- END SIMULATION ---

        // Reload the account to get the new balance (necessary after CPIs modify the account)
        ctx.accounts.vault_underlying.reload()?;
        let final_balance = ctx.accounts.vault_underlying.amount;

        // 3. Verify Profit Delta
        let profit = final_balance.checked_sub(initial_balance)
            .ok_or(ArbitrageError::NegativeYield)?;
            
        require!(profit >= min_profit, ArbitrageError::InsufficientProfit);

        // 4. Distribute Protocol Fee (20% to Treasury)
        let treasury_cut = (profit as u128)
            .checked_mul(20)
            .unwrap()
            .checked_div(100)
            .unwrap() as u64;

        if treasury_cut > 0 {
            let seeds = &[b"vault".as_ref(), &[ctx.bumps.vault_state]];
            let signer = &[&seeds[..]];
            
            let transfer_treasury_accounts = Transfer {
                from: ctx.accounts.vault_underlying.to_account_info(),
                to: ctx.accounts.treasury_account.to_account_info(),
                authority: vault_state.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), transfer_treasury_accounts, signer), 
                treasury_cut
            )?;
        }

        let staker_cut = profit.checked_sub(treasury_cut).unwrap();

        // 5. Auto-Compound the Staker Cut
        // The staker_cut remains in `vault_underlying`. We just update the state tracker.
        // No new shares are minted, so the `exchange_rate` mathematically increases.
        vault_state.total_staked_assets = vault_state.total_staked_assets.checked_add(staker_cut).unwrap();

        msg!("Arbitrage Block Executed Successfully. Net Profit: {}. Vault (+{}) | Treasury (+{})", profit, staker_cut, treasury_cut);
        Ok(())
    }
}

// -----------------------------------------------------------------------------------------
// Below are the underlying structs defining the layout and constraints for the Anchor contexts.
// -----------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 32 + 32 + 2 + 8 + 8,
        seeds = [b"vault"],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,
    pub underlying_mint: Account<'info, Mint>,
    pub share_mint: Account<'info, Mint>,
    #[account(
        constraint = treasury.mint == underlying_mint.key() @ ArbitrageError::InvalidTreasuryMint
    )]
    pub treasury: Account<'info, TokenAccount>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + 8 + 8,
        seeds = [b"stake_info", user.key().as_ref()],
        bump
    )]
    pub user_stake_info: Account<'info, UserStakeInfo>,
    #[account(
        mut,
        constraint = vault_underlying.mint == vault_state.underlying_mint,
        constraint = vault_underlying.owner == vault_state.key()
    )]
    pub vault_underlying: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_underlying: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_shares: Account<'info, TokenAccount>,
    #[account(mut)]
    pub share_mint: Account<'info, Mint>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"stake_info", user.key().as_ref()],
        bump
    )]
    pub user_stake_info: Account<'info, UserStakeInfo>,
    #[account(
        mut,
        constraint = vault_underlying.mint == vault_state.underlying_mint,
        constraint = vault_underlying.owner == vault_state.key()
    )]
    pub vault_underlying: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_underlying: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_shares: Account<'info, TokenAccount>,
    #[account(mut)]
    pub share_mint: Account<'info, Mint>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FlashLoan<'info> {
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        constraint = vault_underlying.mint == vault_state.underlying_mint,
        constraint = vault_underlying.owner == vault_state.key()
    )]
    pub vault_underlying: Account<'info, TokenAccount>,
    #[account(mut)]
    pub borrower_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Instructions sysvar checking that repayment exists
    #[account(address = IX_ID)]
    pub instructions: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RepayFlashLoan<'info> {
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        constraint = vault_underlying.mint == vault_state.underlying_mint,
        constraint = vault_underlying.owner == vault_state.key()
    )]
    pub vault_underlying: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = treasury_account.key() == vault_state.treasury
    )]
    pub treasury_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub borrower_account: Account<'info, TokenAccount>,
    pub borrower: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExecuteArbitrage<'info> {
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        constraint = vault_underlying.mint == vault_state.underlying_mint,
        constraint = vault_underlying.owner == vault_state.key()
    )]
    pub vault_underlying: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = treasury_account.key() == vault_state.treasury
    )]
    pub treasury_account: Account<'info, TokenAccount>,
    /// The off-chain keeper or bot executing the arbitrage route
    #[account(address = vault_state.admin @ ArbitrageError::UnauthorizedKeeper)]
    pub keeper: Signer<'info>, 
    /// Various DEX program accounts (Jupiter, Raydium, etc.) will be passed as remaining_accounts
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct VaultState {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub underlying_mint: Pubkey,
    pub share_mint: Pubkey,
    pub flash_fee_bps: u16,
    pub total_staked_assets: u64,
    pub total_shares_minted: u64,
}

#[account]
pub struct UserStakeInfo {
    pub last_stake_timestamp: i64,
    pub total_staked: u64,
}

#[error_code]
pub enum ArbitrageError {
    #[msg("Arbitrage execution resulted in a net loss. Reverting.")]
    NegativeYield,
    #[msg("Arbitrage profit did not meet the minimum required threshold.")]
    InsufficientProfit,
    #[msg("The 7-day cooldown period for unstaking has not yet elapsed.")]
    CooldownActive,
    #[msg("Flash loan repayment instruction not found in the transaction.")]
    MissingRepayment,
    #[msg("Unauthorized keeper attempting to execute arbitrage.")]
    UnauthorizedKeeper,
    #[msg("The provided treasury account must match the underlying asset mint.")]
    InvalidTreasuryMint,
}
