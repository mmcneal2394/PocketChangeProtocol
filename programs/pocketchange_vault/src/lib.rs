use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, MintTo, Burn};

declare_id!("PKcVault11111111111111111111111111111111111");

#[program]
pub mod pocketchange_vault {
    use super::*;

    /// Initializes the Vault parameters, sets the admin, and prepares the xPKC Mint.
    pub fn initialize(ctx: Context<Initialize>, fee_basis_points: u16) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.admin = ctx.accounts.admin.key();
        vault_state.xpkc_mint = ctx.accounts.xpkc_mint.key();
        vault_state.vault_usdc_account = ctx.accounts.vault_usdc_account.key();
        vault_state.fee_basis_points = fee_basis_points; // e.g. 1500 = 15%
        vault_state.total_shares = 0;
        vault_state.total_deposits = 0;
        Ok(())
    }

    /// User deposits USDC into the Vault, and receives xPKC shares representing their pool percentage.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroDeposit);

        // Transfer USDC from User to Vault PDA
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_usdc_account.to_account_info(),
            to: ctx.accounts.vault_usdc_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Calculate Shares to Mint (Standard x * total_shares / total_deposits)
        let shares_to_mint = if ctx.accounts.vault_state.total_shares == 0 {
            amount
        } else {
            (amount as u128)
                .checked_mul(ctx.accounts.vault_state.total_shares as u128)
                .unwrap()
                .checked_div(ctx.accounts.vault_state.total_deposits as u128)
                .unwrap() as u64
        };

        // Mint xPKC Shares to the User
        let vault_bump = ctx.bumps.vault_state;
        let seeds = &["vault".as_bytes(), &[vault_bump]];
        let signer = &[&seeds[..]];

        let mint_to_accounts = MintTo {
            mint: ctx.accounts.xpkc_mint.to_account_info(),
            to: ctx.accounts.user_xpkc_account.to_account_info(),
            authority: ctx.accounts.vault_state.to_account_info(),
        };
        let mint_to_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            mint_to_accounts,
            signer,
        );
        token::mint_to(mint_to_ctx, shares_to_mint)?;

        // Update Global State
        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.total_deposits = vault_state.total_deposits.checked_add(amount).unwrap();
        vault_state.total_shares = vault_state.total_shares.checked_add(shares_to_mint).unwrap();

        msg!("Deposited {} USDC, Minted {} xPKC", amount, shares_to_mint);
        Ok(())
    }

    /// Allows the Admin (Live Arbitrage Engine) to execute flash loans out of the pool.
    /// The admin MUST repay the loan + profit within the SAME transaction via CPI, or it reverts.
    pub fn process_arbitrage(ctx: Context<ProcessArbitrage>, flash_loan_amount: u64, min_profit: u64) -> Result<()> {
        let vault_state = &ctx.accounts.vault_state;
        require!(ctx.accounts.admin.key() == vault_state.admin, VaultError::Unauthorized);
        
        // 1. Send USDC to Engine/Executor (Instruction 1)
        // 2. Engine does Raydium -> Orca swaps externally (Instruction 2)
        // 3. Engine Repays USDC + Profit back to Vault (Instruction 3)
        // Note: For atomic composition, this requires CPI or a Flash Loan Callback pattern (e.g. `invoke`).
        
        // Simplified Demo representation:
        // Instead of CPI, we can verify that before instruction ends, vault balance > previous balance + min_profit
        
        // In a true implementation, we would transfer out to admin, then expect admin to transfer back.
        // It relies on transaction-wide composability verifying balance state at the end of the PTB.
        
        msg!("Arbitrage Authorized for {} USDC. Engine must return {} + {}", flash_loan_amount, flash_loan_amount, min_profit);
        
        Ok(())
    }

    /// User Burns their xPKC to withdraw their share of the USDC Pool
    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        require!(shares > 0, VaultError::ZeroWithdraw);
        let vault_state = &mut ctx.accounts.vault_state;

        // Calculate User's Underlying USDC balance
        let usdc_to_return = (shares as u128)
            .checked_mul(vault_state.total_deposits as u128)
            .unwrap()
            .checked_div(vault_state.total_shares as u128)
            .unwrap() as u64;

        // Burn User's xPKC
        let burn_accounts = Burn {
            mint: ctx.accounts.xpkc_mint.to_account_info(),
            from: ctx.accounts.user_xpkc_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let burn_ctx = CpiContext::new(cpi_program, burn_accounts);
        token::burn(burn_ctx, shares)?;

        // Transfer USDC to User
        let vault_bump = ctx.bumps.vault_state;
        let seeds = &["vault".as_bytes(), &[vault_bump]];
        let signer = &[&seeds[..]];

        let transfer_accounts = Transfer {
            from: ctx.accounts.vault_usdc_account.to_account_info(),
            to: ctx.accounts.user_usdc_account.to_account_info(),
            authority: ctx.accounts.vault_state.to_account_info(),
        };
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
            signer,
        );
        token::transfer(transfer_ctx, usdc_to_return)?;

        // Update state
        vault_state.total_shares = vault_state.total_shares.checked_sub(shares).unwrap();
        vault_state.total_deposits = vault_state.total_deposits.checked_sub(usdc_to_return).unwrap();

        Ok(())
    }
}

// --------------------------------------------------------
// Account Validations
// --------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 32 + 2 + 8 + 8,
        seeds = [b"vault"],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,

    pub xpkc_mint: Account<'info, Mint>,
    pub vault_usdc_account: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault"],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut)]
    pub user_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_usdc_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub xpkc_mint: Account<'info, Mint>,
    #[account(mut)]
    pub user_xpkc_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ProcessArbitrage<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [b"vault"], bump)]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut)]
    pub vault_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub admin_usdc_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [b"vault"], bump)]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut)]
    pub vault_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_usdc_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub xpkc_mint: Account<'info, Mint>,
    #[account(mut)]
    pub user_xpkc_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// --------------------------------------------------------
// State & Errors
// --------------------------------------------------------

#[account]
pub struct VaultState {
    pub admin: Pubkey,
    pub xpkc_mint: Pubkey,
    pub vault_usdc_account: Pubkey,
    pub fee_basis_points: u16,
    pub total_shares: u64,
    pub total_deposits: u64,
}

#[error_code]
pub enum VaultError {
    #[msg("Deposit amount must be greater than zero.")]
    ZeroDeposit,
    #[msg("Withdraw amount must be greater than zero.")]
    ZeroWithdraw,
    #[msg("Unauthorized execution. Only the primary engine node can flash-loan.")]
    Unauthorized,
}
